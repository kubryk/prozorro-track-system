import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export type EdrpouRole = 'customer' | 'supplier';

@Injectable()
export class SearchService {
    constructor(private readonly prisma: PrismaService) { }

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

        if (params.dateFrom || params.dateTo) {
            where[dateField] = {};
            if (params.dateFrom) {
                where[dateField].gte = new Date(params.dateFrom);
            }
            if (params.dateTo) {
                where[dateField].lte = new Date(params.dateTo);
            }
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

        if (params.dateFrom || params.dateTo) {
            where[dateField] = {};
            if (params.dateFrom) {
                where[dateField].gte = new Date(params.dateFrom);
            }
            if (params.dateTo) {
                where[dateField].lte = new Date(params.dateTo);
            }
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
        const [tenderCount, contractCount, syncState] = await Promise.all([
            this.prisma.tender.count(),
            this.prisma.contract.count(),
            this.prisma.syncState.findFirst({
                orderBy: { updatedAt: 'desc' }
            }),
        ]);
        return {
            tenders: tenderCount,
            contracts: contractCount,
            lastSync: syncState?.updatedAt || null
        };
    }
}
