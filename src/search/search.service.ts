import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { ProzorroService } from '../prozorro/prozorro.service';

export type EdrpouRole = 'customer' | 'supplier';
type TenderRoleFilter = EdrpouRole | EdrpouRole[];
type ContractRoleFilter = EdrpouRole | EdrpouRole[];

const DATE_ONLY_QUERY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateQueryBoundary(
    value: string,
    boundary: 'start' | 'end',
): Date {
    if (DATE_ONLY_QUERY_PATTERN.test(value)) {
        const [year, month, day] = value.split('-').map(Number);

        if (boundary === 'end') {
            return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
        }

        return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    }

    return new Date(value);
}

function buildDateTimeFilter(
    dateFrom?: string,
    dateTo?: string,
): Prisma.DateTimeFilter | undefined {
    if (!dateFrom && !dateTo) {
        return undefined;
    }

    const filter: Prisma.DateTimeFilter = {};

    if (dateFrom) {
        filter.gte = parseDateQueryBoundary(dateFrom, 'start');
    }

    if (dateTo) {
        filter.lte = parseDateQueryBoundary(dateTo, 'end');
    }

    return filter;
}

type ContractSortOption =
    | 'default'
    | 'amountAsc'
    | 'amountDesc'
    | 'dateSignedDesc'
    | 'dateSignedAsc';

type TenderSortOption =
    | 'default'
    | 'dateCreatedDesc'
    | 'dateCreatedAsc'
    | 'amountAsc'
    | 'amountDesc';

type TenderSearchParams = {
    edrpou?: string;
    role?: TenderRoleFilter;
    status?: string | string[];
    dateFrom?: string;
    dateTo?: string;
    dateType?: string;
    sort?: TenderSortOption;
    priceFrom?: number;
    priceTo?: number;
    skip?: number;
    take?: number;
};

type ContractSearchParams = {
    edrpou?: string;
    role?: ContractRoleFilter;
    status?: string | string[];
    dateFrom?: string;
    dateTo?: string;
    priceFrom?: number;
    priceTo?: number;
    dateType?: string;
    sort?: ContractSortOption;
    skip?: number;
    take?: number;
};

function buildTenderOrderBy(
    sort: TenderSortOption | undefined,
    dateField: keyof Pick<
        Prisma.TenderOrderByWithRelationInput,
        | 'dateModified'
        | 'dateCreated'
        | 'tenderPeriodStart'
        | 'tenderPeriodEnd'
        | 'enquiryPeriodStart'
        | 'enquiryPeriodEnd'
        | 'auctionPeriodStart'
        | 'awardPeriodStart'
    >,
): Prisma.TenderOrderByWithRelationInput[] {
    const defaultOrder = { [dateField]: 'desc' } as Prisma.TenderOrderByWithRelationInput;

    switch (sort) {
        case 'dateCreatedAsc':
            return [
                { dateCreated: 'asc' },
                { dateModified: 'desc' },
            ];
        case 'dateCreatedDesc':
            return [
                { dateCreated: 'desc' },
                { dateModified: 'desc' },
            ];
        case 'amountAsc':
            return [
                { amount: 'asc' },
                { dateCreated: 'desc' },
            ];
        case 'amountDesc':
            return [
                { amount: 'desc' },
                { dateCreated: 'desc' },
            ];
        case 'default':
        default:
            return [defaultOrder];
    }
}

function buildContractOrderBy(
    sort: ContractSortOption | undefined,
    dateField: 'dateModified' | 'dateSigned',
): Prisma.ContractOrderByWithRelationInput[] {
    const defaultOrder = { [dateField]: 'desc' } as Prisma.ContractOrderByWithRelationInput;

    switch (sort) {
        case 'amountAsc':
            return [
                { amount: 'asc' },
                { dateSigned: 'desc' },
            ];
        case 'amountDesc':
            return [
                { amount: 'desc' },
                { dateSigned: 'desc' },
            ];
        case 'dateSignedAsc':
            return [
                { dateSigned: 'asc' },
                { dateModified: 'desc' },
            ];
        case 'dateSignedDesc':
            return [
                { dateSigned: 'desc' },
                { dateModified: 'desc' },
            ];
        case 'default':
        default:
            return [defaultOrder];
    }
}

@Injectable()
export class SearchService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly prozorroService: ProzorroService,
        @InjectQueue('tender-processor') private readonly tenderQueue: Queue,
    ) { }

    async getTenderProfileByTenderNumber(tenderNumber: string) {
        const normalizedTenderNumber = tenderNumber
            .trim()
            .replace(/[‐‑–—−]/g, '-')
            .toUpperCase();

        const tender = await this.prisma.tender.findFirst({
            where: {
                OR: [
                    {
                        tenderID: {
                            equals: normalizedTenderNumber,
                            mode: 'insensitive',
                        },
                    },
                    {
                        id: normalizedTenderNumber,
                    },
                ],
            },
            include: {
                contracts: {
                    orderBy: {
                        dateSigned: 'desc',
                    },
                },
            },
        });

        if (!tender) {
            return null;
        }

        const tenderDetails = await this.prozorroService.getTenderDetails(tender.id);
        const contracts = await Promise.all(
            tender.contracts.map(async (contract) => {
                try {
                    const details = await this.prozorroService.getContractDetails(
                        tender.id,
                        contract.id,
                    );

                    return {
                        ...contract,
                        details,
                    };
                } catch {
                    return {
                        ...contract,
                        details: null,
                    };
                }
            }),
        );

        return {
            tender,
            tenderDetails,
            contracts,
        };
    }

    /**
     * Universal tender search with filters:
     * - edrpou + role: search by customer or supplier EDRPOU
     * - status: tender status (e.g. 'complete', 'active')
     * - dateFrom / dateTo: filter by dateModified range
     * - priceFrom / priceTo: filter by amount range
     * - skip / take: pagination
     */
    async searchTenders(params: TenderSearchParams) {
        const safeTake = Math.min(params.take || 20, 100);
        const skip = params.skip || 0;
        const dateType = params.dateType || 'dateModified';
        const dateField = dateType === 'dateCreated' ? 'dateCreated' :
            dateType === 'tenderPeriodStart' ? 'tenderPeriodStart' :
                dateType === 'tenderPeriodEnd' ? 'tenderPeriodEnd' :
                    dateType === 'enquiryPeriodStart' ? 'enquiryPeriodStart' :
                        dateType === 'enquiryPeriodEnd' ? 'enquiryPeriodEnd' :
                            dateType === 'auctionPeriodStart' ? 'auctionPeriodStart' :
                                dateType === 'awardPeriodStart' ? 'awardPeriodStart' :
                                    'dateModified';
        const where = this.buildTenderWhere(params);
        const orderBy = buildTenderOrderBy(params.sort, dateField);

        const [data, total, relatedContractTotal] = await Promise.all([
            this.prisma.tender.findMany({
                where,
                skip,
                take: safeTake,
                orderBy,
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
            }),
            this.prisma.tender.count({ where }),
            this.prisma.contract.count({
                where: {
                    tender: where,
                },
            }),
        ]);

        return {
            data,
            total,
            relatedContractTotal,
            skip,
            take: safeTake,
        };
    }

    /**
     * Universal contract search with filters:
     * - edrpou + role: search by supplier EDRPOU or customer EDRPOU (via tender)
     * - status: contract status (e.g. 'active', 'terminated')
     * - dateFrom / dateTo: filter by dateSigned range
     * - priceFrom / priceTo: filter by amount range
     * - skip / take: pagination
     */
    async searchContracts(params: ContractSearchParams) {
        const safeTake = Math.min(params.take || 20, 100);
        const skip = params.skip || 0;
        const dateType = params.dateType || 'dateSigned';
        const dateField = dateType === 'dateModified' ? 'dateModified' : 'dateSigned';
        const where = this.buildContractWhere(params);
        const orderBy = buildContractOrderBy(params.sort, dateField);

        const [data, total, relatedTenders] = await Promise.all([
            this.prisma.contract.findMany({
                where,
                skip,
                take: safeTake,
                orderBy,
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
            }),
            this.prisma.contract.count({ where }),
            this.prisma.contract.findMany({
                where,
                distinct: ['tenderId'],
                select: {
                    tenderId: true,
                },
            }),
        ]);

        return {
            data,
            total,
            relatedTenderTotal: relatedTenders.length,
            skip,
            take: safeTake,
        };
    }

    async getPortfolioAnalytics(params: {
        edrpou: string;
        role: ContractRoleFilter;
        year: number;
        priceFrom?: number;
        tenderStatus?: string | string[];
    }) {
        const dateFrom = `${params.year}-01-01`;
        const dateTo = `${params.year}-12-31`;
        const tenderWhere = this.buildTenderWhere({
            edrpou: params.edrpou,
            role: params.role,
            dateFrom,
            dateTo,
            dateType: 'dateCreated',
            priceFrom: params.priceFrom,
            status: params.tenderStatus,
        });
        const contractWhere = this.buildContractWhere({
            edrpou: params.edrpou,
            role: params.role,
            dateFrom,
            dateTo,
            dateType: 'dateSigned',
            priceFrom: params.priceFrom,
        });

        if (params.tenderStatus) {
            const statuses = Array.isArray(params.tenderStatus)
                ? params.tenderStatus
                : [params.tenderStatus];
            const tenderStatusFilter: Prisma.ContractWhereInput = {
                tender: {
                    status: {
                        in: statuses,
                    },
                },
            };

            if (contractWhere.AND) {
                contractWhere.AND = Array.isArray(contractWhere.AND)
                    ? [...contractWhere.AND, tenderStatusFilter]
                    : [contractWhere.AND, tenderStatusFilter];
            } else {
                contractWhere.AND = [tenderStatusFilter];
            }
        }

        const [tenderTotal, contractTotal, contractRows] = await Promise.all([
            this.prisma.tender.count({ where: tenderWhere }),
            this.prisma.contract.count({ where: contractWhere }),
            this.prisma.contract.findMany({
                where: contractWhere,
                select: {
                    amount: true,
                    currency: true,
                    dateSigned: true,
                    supplierName: true,
                    supplierEdrpou: true,
                    tender: {
                        select: {
                            title: true,
                            customerName: true,
                            customerEdrpou: true,
                        },
                    },
                },
            }),
        ]);

        const totalAmount = contractRows.reduce((sum, row) => {
            return sum + (typeof row.amount === 'number' ? row.amount : 0);
        }, 0);
        const contractsWithAmount = contractRows.filter((row) => typeof row.amount === 'number');
        const averageAmount = contractsWithAmount.length > 0
            ? totalAmount / contractsWithAmount.length
            : null;
        const topCounterparties = this.buildTopCounterparties(
            contractRows,
            params.edrpou,
        );
        const currencies = Array.from(
            new Set(
                contractRows
                    .map((row) => row.currency)
                    .filter((value): value is string => Boolean(value)),
            ),
        );

        return {
            tenderTotal,
            contractTotal,
            totalAmount,
            averageAmount,
            currencies,
            topCounterparties,
        };
    }

    private buildTenderWhere(params: TenderSearchParams): Prisma.TenderWhereInput {
        const where: Prisma.TenderWhereInput = {};
        const roles = Array.isArray(params.role)
            ? params.role
            : params.role
                ? [params.role]
                : ['customer'];
        const statuses = Array.isArray(params.status)
            ? params.status
            : params.status
                ? [params.status]
                : [];

        if (params.edrpou) {
            if (roles.length === 1 && roles[0] === 'customer') {
                where.customerEdrpou = params.edrpou;
            } else if (roles.length === 1 && roles[0] === 'supplier') {
                where.contracts = {
                    some: { supplierEdrpou: params.edrpou },
                };
            } else {
                where.OR = [
                    { customerEdrpou: params.edrpou },
                    {
                        contracts: {
                            some: { supplierEdrpou: params.edrpou },
                        },
                    },
                ];
            }
        }

        if (statuses.length > 0) {
            where.status = {
                in: statuses,
            };
        }

        const dateType = params.dateType || 'dateModified';
        const dateField = dateType === 'dateCreated' ? 'dateCreated' :
            dateType === 'tenderPeriodStart' ? 'tenderPeriodStart' :
                dateType === 'tenderPeriodEnd' ? 'tenderPeriodEnd' :
                    dateType === 'enquiryPeriodStart' ? 'enquiryPeriodStart' :
                        dateType === 'enquiryPeriodEnd' ? 'enquiryPeriodEnd' :
                            dateType === 'auctionPeriodStart' ? 'auctionPeriodStart' :
                                dateType === 'awardPeriodStart' ? 'awardPeriodStart' :
                                    'dateModified';
        const dateFilter = buildDateTimeFilter(params.dateFrom, params.dateTo);
        if (dateFilter) {
            where[dateField] = dateFilter;
        }

        if (params.priceFrom !== undefined || params.priceTo !== undefined) {
            where.amount = {};
            if (params.priceFrom !== undefined) {
                where.amount.gte = params.priceFrom;
            }
            if (params.priceTo !== undefined) {
                where.amount.lte = params.priceTo;
            }
        }

        return where;
    }

    private buildContractWhere(params: ContractSearchParams): Prisma.ContractWhereInput {
        const where: Prisma.ContractWhereInput = {};
        const roles = Array.isArray(params.role)
            ? params.role
            : params.role
                ? [params.role]
                : ['supplier'];
        const statuses = Array.isArray(params.status)
            ? params.status
            : params.status
                ? [params.status]
                : [];

        if (params.edrpou) {
            if (roles.length === 1 && roles[0] === 'supplier') {
                where.supplierEdrpou = params.edrpou;
            } else if (roles.length === 1 && roles[0] === 'customer') {
                where.tender = { customerEdrpou: params.edrpou };
            } else {
                where.OR = [
                    { supplierEdrpou: params.edrpou },
                    { tender: { customerEdrpou: params.edrpou } },
                ];
            }
        }

        if (statuses.length > 0) {
            where.status = {
                in: statuses,
            };
        }

        const dateType = params.dateType || 'dateSigned';
        const dateField = dateType === 'dateModified' ? 'dateModified' : 'dateSigned';
        const dateFilter = buildDateTimeFilter(params.dateFrom, params.dateTo);
        if (dateFilter) {
            where[dateField] = dateFilter;
        }

        if (params.priceFrom !== undefined || params.priceTo !== undefined) {
            where.amount = {};
            if (params.priceFrom !== undefined) {
                where.amount.gte = params.priceFrom;
            }
            if (params.priceTo !== undefined) {
                where.amount.lte = params.priceTo;
            }
        }

        return where;
    }

    private buildTopCounterparties(
        contractRows: Array<{
            amount: number | null;
            supplierEdrpou: string | null;
            supplierName: string | null;
            tender: {
                customerEdrpou: string | null;
                customerName: string | null;
            };
        }>,
        edrpou: string,
    ) {
        const counterpartyMap = new Map<string, { name: string; contracts: number; amount: number }>();

        for (const row of contractRows) {
            const candidates: string[] = [];

            if (row.supplierEdrpou === edrpou && row.tender.customerName) {
                candidates.push(row.tender.customerName);
            }

            if (row.tender.customerEdrpou === edrpou && row.supplierName) {
                candidates.push(row.supplierName);
            }

            if (candidates.length === 0) {
                if (row.supplierName) {
                    candidates.push(row.supplierName);
                } else if (row.tender.customerName) {
                    candidates.push(row.tender.customerName);
                }
            }

            for (const candidate of Array.from(new Set(candidates))) {
                const key = candidate.trim().toLowerCase();
                if (!key) {
                    continue;
                }

                const existing = counterpartyMap.get(key) ?? {
                    name: candidate.trim(),
                    contracts: 0,
                    amount: 0,
                };
                existing.contracts += 1;
                existing.amount += typeof row.amount === 'number' ? row.amount : 0;
                counterpartyMap.set(key, existing);
            }
        }

        return Array.from(counterpartyMap.values())
            .sort((left, right) => {
                if (right.contracts !== left.contracts) {
                    return right.contracts - left.contracts;
                }

                return right.amount - left.amount;
            })
            .slice(0, 5);
    }

    async getStats() {
        const [tenderCount, contractCount, syncState, incompleteTenderCount, queueCounts] = await Promise.all([
            this.prisma.tender.count(),
            this.prisma.contract.count(),
            this.prisma.syncState.findFirst({
                orderBy: { updatedAt: 'desc' }
            }),
            this.prisma.tender.count({
                where: { syncStatus: { in: ['PARTIAL', 'FAILED'] } },
            }),
            this.tenderQueue.getJobCounts(
                'waiting',
                'active',
                'delayed',
                'prioritized',
                'waiting-children',
            ),
        ]);
        const pendingJobs =
            (queueCounts.waiting || 0) +
            (queueCounts.active || 0) +
            (queueCounts.delayed || 0) +
            (queueCounts.prioritized || 0) +
            (queueCounts['waiting-children'] || 0);
        const isFullySynced = pendingJobs === 0 && incompleteTenderCount === 0;

        return {
            tenders: tenderCount,
            contracts: contractCount,
            lastSync: isFullySynced ? syncState?.updatedAt || null : null
        };
    }
}
