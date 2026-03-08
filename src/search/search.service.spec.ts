import { SearchService } from './search.service';

describe('SearchService', () => {
  let service: SearchService;
  let prisma: {
    tender: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
    contract: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
    syncState: {
      findFirst: jest.Mock;
    };
  };
  let tenderQueue: {
    getJobCounts: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      tender: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      contract: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      syncState: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    tenderQueue = {
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 0,
        active: 0,
        delayed: 0,
        prioritized: 0,
        'waiting-children': 0,
      }),
    };

    service = new SearchService(prisma as any, tenderQueue as any);
  });

  it('будує supplier-фільтр для тендерів і обмежує take до 100', async () => {
    await service.searchTenders({
      edrpou: '12345678',
      role: 'supplier',
      priceFrom: 1000,
      priceTo: 5000,
      take: 500,
    });

    expect(prisma.tender.findMany).toHaveBeenCalledWith({
      where: {
        contracts: {
          some: { supplierEdrpou: '12345678' },
        },
        amount: {
          gte: 1000,
          lte: 5000,
        },
      },
      skip: 0,
      take: 100,
      orderBy: { dateModified: 'desc' },
      include: {
        contracts: {
          select: {
            id: true,
            contractID: true,
            status: true,
            amount: true,
            supplierEdrpou: true,
            supplierName: true,
          },
        },
      },
    });
    expect(prisma.tender.count).toHaveBeenCalledWith({
      where: {
        contracts: {
          some: { supplierEdrpou: '12345678' },
        },
        amount: {
          gte: 1000,
          lte: 5000,
        },
      },
    });
  });

  it('робить dateTo inclusive до кінця доби для тендерів і підтримує dateCreated як поле фільтрації', async () => {
    await service.searchTenders({
      dateType: 'dateCreated',
      dateFrom: '2026-03-08',
      dateTo: '2026-03-08',
    });

    expect(prisma.tender.findMany).toHaveBeenCalledWith({
      where: {
        dateCreated: {
          gte: new Date('2026-03-08T00:00:00.000Z'),
          lte: new Date('2026-03-08T23:59:59.999Z'),
        },
      },
      skip: 0,
      take: 20,
      orderBy: { dateCreated: 'desc' },
      include: {
        contracts: {
          select: {
            id: true,
            contractID: true,
            status: true,
            amount: true,
            supplierEdrpou: true,
            supplierName: true,
          },
        },
      },
    });
    expect(prisma.tender.count).toHaveBeenCalledWith({
      where: {
        dateCreated: {
          gte: new Date('2026-03-08T00:00:00.000Z'),
          lte: new Date('2026-03-08T23:59:59.999Z'),
        },
      },
    });
  });

  it('робить dateTo inclusive до кінця доби для контрактів', async () => {
    await service.searchContracts({
      dateType: 'dateSigned',
      dateTo: '2026-03-08',
    });

    expect(prisma.contract.findMany).toHaveBeenCalledWith({
      where: {
        dateSigned: {
          lte: new Date('2026-03-08T23:59:59.999Z'),
        },
      },
      skip: 0,
      take: 20,
      orderBy: { dateSigned: 'desc' },
      include: {
        tender: {
          select: {
            id: true,
            tenderID: true,
            title: true,
            customerEdrpou: true,
            customerName: true,
            status: true,
          },
        },
      },
    });
    expect(prisma.contract.count).toHaveBeenCalledWith({
      where: {
        dateSigned: {
          lte: new Date('2026-03-08T23:59:59.999Z'),
        },
      },
    });
  });

  it('повертає агреговану статистику по тендерах, контрактах і синку', async () => {
    prisma.tender.count
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(0);
    prisma.contract.count.mockResolvedValue(7);
    prisma.syncState.findFirst.mockResolvedValue({
      updatedAt: new Date('2026-03-08T10:00:00.000Z'),
    });

    await expect(service.getStats()).resolves.toEqual({
      tenders: 11,
      contracts: 7,
      lastSync: new Date('2026-03-08T10:00:00.000Z'),
    });
  });

  it('повертає lastSync як null, якщо в черзі є backlog або лишилися incomplete тендери', async () => {
    prisma.tender.count
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(2);
    prisma.contract.count.mockResolvedValue(7);
    prisma.syncState.findFirst.mockResolvedValue({
      updatedAt: new Date('2026-03-08T10:00:00.000Z'),
    });
    tenderQueue.getJobCounts.mockResolvedValue({
      waiting: 1,
      active: 0,
      delayed: 0,
      prioritized: 0,
      'waiting-children': 0,
    });

    await expect(service.getStats()).resolves.toEqual({
      tenders: 11,
      contracts: 7,
      lastSync: null,
    });
    expect(prisma.tender.count).toHaveBeenNthCalledWith(2, {
      where: { syncStatus: { in: ['PARTIAL', 'FAILED'] } },
    });
    expect(tenderQueue.getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'delayed',
      'prioritized',
      'waiting-children',
    );
  });
});
