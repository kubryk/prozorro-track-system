import { Logger } from '@nestjs/common';
import { TenderProcessor } from './tender.processor';

describe('TenderProcessor', () => {
  let processor: TenderProcessor;
  let prisma: {
    tender: { upsert: jest.Mock };
    contract: { upsert: jest.Mock; deleteMany: jest.Mock };
  };
  let prozorroApi: {
    getTenderDetails: jest.Mock;
    getContractDetails: jest.Mock;
  };

  beforeEach(() => {
    jest.spyOn(global, 'setInterval').mockImplementation(() => 0 as any);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    prisma = {
      tender: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
      contract: {
        upsert: jest.fn().mockResolvedValue(undefined),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    prozorroApi = {
      getTenderDetails: jest.fn(),
      getContractDetails: jest.fn(),
    };

    processor = new TenderProcessor(prisma as any, prozorroApi as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('зберігає upstream dateCreated для тендера під час upsert', async () => {
    prozorroApi.getTenderDetails.mockResolvedValue({
      id: 'tender-date-created',
      tenderID: 'UA-2026-01-01-000010-a',
      title: 'Tender with created date',
      status: 'active.tendering',
      value: { amount: '1000', currency: 'UAH' },
      dateCreated: '2025-12-31T10:15:00.000Z',
      dateModified: '2026-01-01T00:00:00.000Z',
      contracts: [],
    });

    await processor.process({ data: { tenderId: 'tender-date-created' } } as any);

    expect(prisma.tender.upsert).toHaveBeenCalledWith({
      where: { id: 'tender-date-created' },
      update: expect.objectContaining({
        dateCreated: new Date('2025-12-31T10:15:00.000Z'),
        dateModified: new Date('2026-01-01T00:00:00.000Z'),
      }),
      create: expect.objectContaining({
        id: 'tender-date-created',
        dateCreated: new Date('2025-12-31T10:15:00.000Z'),
        dateModified: new Date('2026-01-01T00:00:00.000Z'),
      }),
    });
  });

  it('видаляє застарілі контракти, яких більше немає в Prozorro payload', async () => {
    prozorroApi.getTenderDetails.mockResolvedValue({
      id: 'tender-1',
      tenderID: 'UA-2026-01-01-000001-a',
      title: 'Test tender',
      status: 'active.tendering',
      value: { amount: '1000', currency: 'UAH' },
      dateModified: '2026-01-01T00:00:00.000Z',
      contracts: [{ id: 'contract-1' }],
    });
    prozorroApi.getContractDetails.mockResolvedValue({
      id: 'contract-1',
      contractID: 'C-1',
      status: 'active',
      value: { amount: '1000', currency: 'UAH' },
      suppliers: [],
    });

    await processor.process({ data: { tenderId: 'tender-1' } } as any);

    expect(prisma.contract.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.contract.deleteMany).toHaveBeenCalledWith({
      where: {
        tenderId: 'tender-1',
        id: { notIn: ['contract-1'] },
      },
    });
  });

  it('очищає всі контракти тендера, якщо в актуальному payload їх більше немає', async () => {
    prozorroApi.getTenderDetails.mockResolvedValue({
      id: 'tender-2',
      tenderID: 'UA-2026-01-01-000002-a',
      title: 'Tender without contracts',
      status: 'complete',
      value: { amount: '500', currency: 'UAH' },
      dateModified: '2026-01-02T00:00:00.000Z',
      contracts: [],
    });

    await processor.process({ data: { tenderId: 'tender-2' } } as any);

    expect(prozorroApi.getContractDetails).not.toHaveBeenCalled();
    expect(prisma.contract.upsert).not.toHaveBeenCalled();
    expect(prisma.contract.deleteMany).toHaveBeenCalledWith({
      where: { tenderId: 'tender-2' },
    });
  });

  it('позначає тендер як FAILED, якщо воркер не зміг отримати деталі тендера', async () => {
    prozorroApi.getTenderDetails.mockRejectedValue(new Error('upstream timeout'));

    await expect(
      processor.process({
        data: {
          tenderId: 'tender-3',
          dateModified: '2026-01-03T00:00:00.000Z',
        },
      } as any),
    ).rejects.toThrow('upstream timeout');

    expect(prisma.tender.upsert).toHaveBeenCalledWith({
      where: { id: 'tender-3' },
      update: {
        year: 2026,
        dateModified: new Date('2026-01-03T00:00:00.000Z'),
        syncStatus: 'FAILED',
      },
      create: {
        id: 'tender-3',
        year: 2026,
        dateModified: new Date('2026-01-03T00:00:00.000Z'),
        syncStatus: 'FAILED',
      },
    });
  });

  it('позначає тендер як FAILED, якщо Prozorro повернув порожній payload', async () => {
    prozorroApi.getTenderDetails.mockResolvedValue(null);

    await expect(
      processor.process({
        data: {
          tenderId: 'tender-4',
          dateModified: '2026-01-04T00:00:00.000Z',
        },
      } as any),
    ).rejects.toThrow('No details found for tender: tender-4');

    expect(prisma.tender.upsert).toHaveBeenCalledWith({
      where: { id: 'tender-4' },
      update: {
        year: 2026,
        dateModified: new Date('2026-01-04T00:00:00.000Z'),
        syncStatus: 'FAILED',
      },
      create: {
        id: 'tender-4',
        year: 2026,
        dateModified: new Date('2026-01-04T00:00:00.000Z'),
        syncStatus: 'FAILED',
      },
    });
  });
});
