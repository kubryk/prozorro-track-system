import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export type EdrpouRole = 'customer' | 'supplier';

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

@Injectable()
export class SearchService {
    constructor(
        private readonly prisma: PrismaService,
        @InjectQueue('tender-processor') private readonly tenderQueue: Queue,
    ) { }

    /**
     * Universal tender search with filters:
     * - edrpou + role: search by customer or supplier EDRPOU
     * - status: tender status (e.g. 'complete', 'active')
     * - dateFrom / dateTo: filter by dateModified range
     * - priceFrom / priceTo: filter by amount range
     * - skip / take: pagination
     */
    async searchTenders(params: {
        edrpou?: string;
        role?: EdrpouRole;
        status?: string;
        dateFrom?: string;
        dateTo?: string;
        dateType?: string;
        priceFrom?: number;
        priceTo?: number;
        skip?: number;
        take?: number;
    }) {
        const safeTake = Math.min(params.take || 20, 100);
        const skip = params.skip || 0;

        const where: any = {};

        // EDRPOU filter based on role
        if (params.edrpou) {
            const role = params.role || 'customer';
            if (role === 'customer') {
                where.customerEdrpou = params.edrpou;
            } else {
                // supplier — search tenders that have contracts with this supplier
                where.contracts = {
                    some: { supplierEdrpou: params.edrpou },
                };
            }
        }

        // Status filter
        if (params.status) {
            where.status = params.status;
        }

        // Date range filter
        const dateType = params.dateType || 'dateModified';
        const dateField = dateType === 'dateCreated' ? 'dateCreated' :
            dateType === 'tenderPeriodStart' ? 'tenderPeriodStart' :
                dateType === 'tenderPeriodEnd' ? 'tenderPeriodEnd' :
                    dateType === 'enquiryPeriodStart' ? 'enquiryPeriodStart' :
                        dateType === 'enquiryPeriodEnd' ? 'enquiryPeriodEnd' :
                            dateType === 'auctionPeriodStart' ? 'auctionPeriodStart' :
                                dateType === 'awardPeriodStart' ? 'awardPeriodStart' :
                                    'dateModified';

        const tenderDateFilter = buildDateTimeFilter(params.dateFrom, params.dateTo);
        if (tenderDateFilter) {
            where[dateField] = tenderDateFilter;
        }

        // Price range filter
        if (params.priceFrom !== undefined || params.priceTo !== undefined) {
            where.amount = {};
            if (params.priceFrom !== undefined) {
                where.amount.gte = params.priceFrom;
            }
            if (params.priceTo !== undefined) {
                where.amount.lte = params.priceTo;
            }
        }

        const [data, total] = await Promise.all([
            this.prisma.tender.findMany({
                where,
                skip,
                take: safeTake,
                orderBy: { [dateField]: 'desc' },
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
        ]);

        return { data, total, skip, take: safeTake };
    }

    /**
     * Universal contract search with filters:
     * - edrpou + role: search by supplier EDRPOU or customer EDRPOU (via tender)
     * - status: contract status (e.g. 'active', 'terminated')
     * - dateFrom / dateTo: filter by dateSigned range
     * - priceFrom / priceTo: filter by amount range
     * - skip / take: pagination
     */
    async searchContracts(params: {
        edrpou?: string;
        role?: EdrpouRole;
        status?: string;
        dateFrom?: string;
        dateTo?: string;
        priceFrom?: number;
        priceTo?: number;
        dateType?: string;
        skip?: number;
        take?: number;
    }) {
        const safeTake = Math.min(params.take || 20, 100);
        const skip = params.skip || 0;

        const where: any = {};

        // EDRPOU filter based on role
        if (params.edrpou) {
            const role = params.role || 'supplier';
            if (role === 'supplier') {
                where.supplierEdrpou = params.edrpou;
            } else {
                // customer — search contracts via related tender's customerEdrpou
                where.tender = { customerEdrpou: params.edrpou };
            }
        }

        // Status filter
        if (params.status) {
            where.status = params.status;
        }

        // Date range filter
        const dateType = params.dateType || 'dateSigned';
        const dateField = dateType === 'dateModified' ? 'dateModified' : 'dateSigned';

        const contractDateFilter = buildDateTimeFilter(params.dateFrom, params.dateTo);
        if (contractDateFilter) {
            where[dateField] = contractDateFilter;
        }

        // Price range filter
        if (params.priceFrom !== undefined || params.priceTo !== undefined) {
            where.amount = {};
            if (params.priceFrom !== undefined) {
                where.amount.gte = params.priceFrom;
            }
            if (params.priceTo !== undefined) {
                where.amount.lte = params.priceTo;
            }
        }

        const [data, total] = await Promise.all([
            this.prisma.contract.findMany({
                where,
                skip,
                take: safeTake,
                orderBy: { [dateField]: 'desc' },
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
        ]);

        return { data, total, skip, take: safeTake };
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
