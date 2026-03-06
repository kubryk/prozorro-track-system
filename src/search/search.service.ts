import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SearchService {
    constructor(private readonly prisma: PrismaService) { }

    async searchTenders(
        edrpou?: string,
        skip: number = 0,
        take: number = 20,
    ) {
        const where = edrpou ? { customerEdrpou: edrpou } : {};

        const [data, total] = await Promise.all([
            this.prisma.tender.findMany({
                where,
                skip,
                take,
                orderBy: { dateModified: 'desc' },
            }),
            this.prisma.tender.count({ where }),
        ]);

        return { data, total, skip, take };
    }

    async searchContracts(
        edrpou?: string,
        skip: number = 0,
        take: number = 20,
    ) {
        const where = edrpou ? { supplierEdrpou: edrpou } : {};

        const [data, total] = await Promise.all([
            this.prisma.contract.findMany({
                where,
                skip,
                take,
                orderBy: { dateModified: 'desc' },
                include: { tender: true } // Include tender info for context
            }),
            this.prisma.contract.count({ where }),
        ]);

        return { data, total, skip, take };
    }
}
