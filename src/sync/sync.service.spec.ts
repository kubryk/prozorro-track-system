import { Logger } from '@nestjs/common';
import { SyncService } from './sync.service';

describe('SyncService', () => {
  let service: SyncService;
  let prisma: {
    syncState: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    tender: {
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };
  let prozorroApi: {
    getTendersPage: jest.Mock;
  };
  let tenderQueue: {
    add: jest.Mock;
    getJobCounts: jest.Mock;
    getJob: jest.Mock;
  };

  beforeEach(() => {
    jest.spyOn(global, 'setInterval').mockImplementation(() => 0 as any);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    delete process.env.APP_ROLE;

    prisma = {
      syncState: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      tender: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };

    prozorroApi = {
      getTendersPage: jest.fn(),
    };

    tenderQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 0,
        active: 0,
        failed: 0,
      }),
      getJob: jest.fn().mockResolvedValue(null),
    };

    service = new SyncService(
      prisma as any,
      prozorroApi as any,
      tenderQueue as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.APP_ROLE;
  });

  it('ставить versioned main jobs, щоб нові апдейти тендера не блокувались старим failed jobId', async () => {
    prisma.syncState.findUnique.mockResolvedValue({ id: 1, lastOffset: 'offset-1' });
    prisma.syncState.update.mockResolvedValue(undefined);
    prozorroApi.getTendersPage
      .mockResolvedValueOnce({
        data: [
          {
            id: 'tender-1',
            dateModified: '2026-01-01T00:00:00.000Z',
          },
        ],
        nextPageOffset: 'offset-2',
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'tender-1',
            dateModified: '2026-01-02T00:00:00.000Z',
          },
        ],
        nextPageOffset: 'offset-3',
      });

    await service.handleSync();
    await service.handleSync();

    expect(tenderQueue.add).toHaveBeenNthCalledWith(
      1,
      'process-tender',
      {
        tenderId: 'tender-1',
        dateModified: '2026-01-01T00:00:00.000Z',
      },
      {
        jobId: `main-tender-1-${Date.parse('2026-01-01T00:00:00.000Z')}`,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: {
          count: 1000,
        },
      },
    );
    expect(tenderQueue.add).toHaveBeenNthCalledWith(
      2,
      'process-tender',
      {
        tenderId: 'tender-1',
        dateModified: '2026-01-02T00:00:00.000Z',
      },
      {
        jobId: `main-tender-1-${Date.parse('2026-01-02T00:00:00.000Z')}`,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: {
          count: 1000,
        },
      },
    );
  });

  it('ставить нові retry jobs для PARTIAL і FAILED тендерів та очищає їх статус', async () => {
    prisma.tender.findMany.mockResolvedValue([
      {
        id: 'tender-partial',
        dateModified: new Date('2026-01-01T00:00:00.000Z'),
        syncStatus: 'PARTIAL',
      },
      {
        id: 'tender-failed',
        dateModified: new Date('2026-01-02T00:00:00.000Z'),
        syncStatus: 'FAILED',
      },
    ]);

    await service.retryPartialTenders();

    expect(prisma.tender.findMany).toHaveBeenCalledWith({
      where: { syncStatus: { in: ['PARTIAL', 'FAILED'] } },
      take: 100,
      orderBy: { dateModified: 'asc' },
    });
    expect(tenderQueue.add).toHaveBeenNthCalledWith(
      1,
      'process-tender',
      {
        tenderId: 'tender-partial',
        dateModified: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        jobId: 'retry-tender-partial',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    expect(tenderQueue.add).toHaveBeenNthCalledWith(
      2,
      'process-tender',
      {
        tenderId: 'tender-failed',
        dateModified: new Date('2026-01-02T00:00:00.000Z'),
      },
      {
        jobId: 'retry-tender-failed',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    expect(prisma.tender.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'tender-partial' },
      data: { syncStatus: 'FULL' },
    });
    expect(prisma.tender.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'tender-failed' },
      data: { syncStatus: 'FULL' },
    });
  });

  it('реанімує існуючий failed retry job замість створення дубля з тим самим jobId', async () => {
    const failedRetryJob = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn(),
    };
    prisma.tender.findMany.mockResolvedValue([
      {
        id: 'tender-failed',
        dateModified: new Date('2026-01-02T00:00:00.000Z'),
        syncStatus: 'FAILED',
      },
    ]);
    tenderQueue.getJob.mockResolvedValue(failedRetryJob);

    await service.retryPartialTenders();

    expect(tenderQueue.getJob).toHaveBeenCalledWith('retry-tender-failed');
    expect(failedRetryJob.getState).toHaveBeenCalledTimes(1);
    expect(failedRetryJob.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(tenderQueue.add).not.toHaveBeenCalled();
    expect(prisma.tender.update).toHaveBeenCalledWith({
      where: { id: 'tender-failed' },
      data: { syncStatus: 'FULL' },
    });
  });
});
