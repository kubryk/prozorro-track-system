import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProzorroService } from '../../prozorro/prozorro.service';

@Processor('tender-processor', {
    concurrency: 50, // Process 50 tenders concurrently
    limiter: {
        max: 50,       // Max 50 requests per 1 second
        duration: 1000,
    },
})
export class TenderProcessor extends WorkerHost {
    private readonly logger = new Logger(TenderProcessor.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly prozorroApi: ProzorroService,
    ) {
        super();
    }

    async process(job: Job<{ tenderId: string }, any, string>): Promise<any> {
        const { tenderId } = job.data;

        try {
            this.logger.log(`Processing tender: ${tenderId}`);

            const tenderDetails = await this.prozorroApi.getTenderDetails(tenderId);

            if (!tenderDetails) {
                this.logger.warn(`No details found for tender: ${tenderId}`);
                return;
            }

            const tenderYear = new Date(tenderDetails.dateModified).getFullYear();

            // Collect Suppliers (from bids)
            const suppliers = new Map<string, string>(); // EDRPOU -> Name
            if (tenderDetails.bids) {
                for (const bid of tenderDetails.bids) {
                    if (bid.tenderers) {
                        for (const tenderer of bid.tenderers) {
                            if (tenderer.identifier && tenderer.identifier.id) {
                                suppliers.set(tenderer.identifier.id, tenderer.name || tenderer.identifier.legalName || null);
                            }
                        }
                    }
                }
            }

            // Collect Customers (procuringEntity)
            const customers = new Map<string, string>(); // EDRPOU -> Name
            if (tenderDetails.procuringEntity && tenderDetails.procuringEntity.identifier && tenderDetails.procuringEntity.identifier.id) {
                const customerEdrpou = tenderDetails.procuringEntity.identifier.id;
                const customerName = tenderDetails.procuringEntity.name || tenderDetails.procuringEntity.identifier.legalName || null;
                customers.set(customerEdrpou, customerName);
            }

            // Save Tender to database
            await this.prisma.tender.upsert({
                where: { id: tenderDetails.id },
                update: {
                    tenderID: tenderDetails.tenderID, // Public string ID
                    status: tenderDetails.status,
                    year: tenderYear,
                    dateModified: new Date(tenderDetails.dateModified),
                },
                create: {
                    id: tenderDetails.id,
                    tenderID: tenderDetails.tenderID,
                    status: tenderDetails.status,
                    year: tenderYear,
                    dateModified: new Date(tenderDetails.dateModified),
                }
            });

            // Save Suppliers
            for (const [edrpou, name] of suppliers) {
                await this.prisma.participant.upsert({
                    where: {
                        tenderId_edrpou_role: {
                            tenderId: tenderDetails.id,
                            edrpou: edrpou,
                            role: 'SUPPLIER'
                        }
                    },
                    update: { name }, // Update name if it changed or was null
                    create: {
                        edrpou: edrpou,
                        name: name,
                        tenderId: tenderDetails.id,
                        role: 'SUPPLIER'
                    }
                });
            }

            // Save Customers
            for (const [edrpou, name] of customers) {
                await this.prisma.participant.upsert({
                    where: {
                        tenderId_edrpou_role: {
                            tenderId: tenderDetails.id,
                            edrpou: edrpou,
                            role: 'CUSTOMER'
                        }
                    },
                    update: { name },
                    create: {
                        edrpou: edrpou,
                        name: name,
                        tenderId: tenderDetails.id,
                        role: 'CUSTOMER'
                    }
                });
            }

            this.logger.log(`Processed tender ${tenderId} (${tenderYear}): ${customers.size} customers, ${suppliers.size} suppliers.`);
            return { success: true, customers: customers.size, suppliers: suppliers.size };
        } catch (error) {
            this.logger.error(`Failed to process tender ${tenderId}: ${error.message}`, error.stack);
            throw error;
        }
    }
}
