import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProzorroService } from '../../prozorro/prozorro.service';

const STATS_INTERVAL_MS = 30_000; // Print summary every 30 seconds

/** Safely parse a value to Float — Prozorro API sometimes returns numbers as strings */
function toFloat(val: any): number | null {
  if (val == null) return null;
  const n = typeof val === 'string' ? parseFloat(val) : val;
  return isNaN(n) ? null : n;
}

@Processor('tender-processor', {
  // concurrency — скільки задач BullMQ тримає одночасно в пам'яті.
  // Реальний ліміт запитів до API — в ProzorroService (WORKER_REQUESTS_PER_SECOND)
  concurrency: parseInt(process.env.WORKER_CONCURRENCY || '50', 10),
})
export class TenderProcessor extends WorkerHost {
  private readonly logger = new Logger(TenderProcessor.name);

  // Aggregate counters for periodic summary
  private processedTenders = 0;
  private processedContracts = 0;
  private errorCount = 0;
  private partialCount = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly prozorroApi: ProzorroService,
  ) {
    super();

    // Print stats summary every 30 seconds
    setInterval(() => {
      if (this.processedTenders === 0 && this.errorCount === 0) return; // nothing to report

      const speed = (this.processedTenders / (STATS_INTERVAL_MS / 1000)).toFixed(1);
      this.logger.log(
        `📊 За ${STATS_INTERVAL_MS / 1000}с: оброблено ${this.processedTenders} тендерів (${speed}/с), ${this.processedContracts} контрактів | помилки: ${this.errorCount}, partial: ${this.partialCount}`,
      );

      // Reset counters
      this.processedTenders = 0;
      this.processedContracts = 0;
      this.errorCount = 0;
      this.partialCount = 0;
    }, STATS_INTERVAL_MS);
  }

  async process(job: Job<{ tenderId: string }, any, string>): Promise<any> {
    const { tenderId } = job.data;

    try {
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
                suppliers.set(
                  tenderer.identifier.id,
                  tenderer.name || tenderer.identifier.legalName || null,
                );
              }
            }
          }
        }
      }

      // Extract Customer (from procuringEntity)
      let customerEdrpou: string | null = null;
      let customerName: string | null = null;
      if (
        tenderDetails.procuringEntity &&
        tenderDetails.procuringEntity.identifier &&
        tenderDetails.procuringEntity.identifier.id
      ) {
        customerEdrpou = tenderDetails.procuringEntity.identifier.id;
        customerName =
          tenderDetails.procuringEntity.name ||
          tenderDetails.procuringEntity.identifier.legalName ||
          null;
      }

      // Save Tender to database
      await this.prisma.tender.upsert({
        where: { id: tenderDetails.id },
        update: {
          tenderID: tenderDetails.tenderID,
          title: tenderDetails.title || null,
          status: tenderDetails.status,
          amount: toFloat(tenderDetails.value?.amount),
          currency: tenderDetails.value?.currency || null,
          year: tenderYear,
          dateModified: new Date(tenderDetails.dateModified),
          customerEdrpou,
          customerName,
        },
        create: {
          id: tenderDetails.id,
          tenderID: tenderDetails.tenderID,
          title: tenderDetails.title || null,
          status: tenderDetails.status,
          amount: tenderDetails.value?.amount || null,
          currency: tenderDetails.value?.currency || null,
          year: tenderYear,
          dateModified: new Date(tenderDetails.dateModified),
          customerEdrpou,
          customerName,
        },
      });

      // Save Contracts (with separate API call for full details)
      let contractsCount = 0;
      let hasFailedContracts = false;
      if (tenderDetails.contracts && Array.isArray(tenderDetails.contracts)) {
        for (const contractRef of tenderDetails.contracts) {
          try {
            // Fetch full contract details from a separate API endpoint
            const contract = await this.prozorroApi.getContractDetails(
              tenderId,
              contractRef.id,
            );
            if (!contract) continue;

            // Support both new format (contract.value.amount) and old format (contract.amount)
            const value = contract.value || {};
            const amount = toFloat(value.amount ?? contract.amount);
            const currency = value.currency || contract.currency || null;
            const vatIncluded =
              value.valueAddedTaxIncluded ??
              contract.valueAddedTaxIncluded ??
              null;
            const amountNet = toFloat(value.amountNet ?? contract.amountNet);

            // Extract Supplier for this contract
            let supplierEdrpou: string | null = null;
            let supplierName: string | null = null;

            if (contract.suppliers && Array.isArray(contract.suppliers) && contract.suppliers.length > 0) {
              const supplier = contract.suppliers[0];
              supplierEdrpou = supplier.identifier?.id || null;
              supplierName = supplier.name || supplier.identifier?.legalName || null;
            }

            await this.prisma.contract.upsert({
              where: { id: contract.id },
              update: {
                contractID: contract.contractID || null,
                status: contract.status || null,
                amount,
                currency,
                valueAddedTaxIncluded: vatIncluded,
                amountNet,
                dateSigned: contract.dateSigned
                  ? new Date(contract.dateSigned)
                  : null,
                date: contract.date ? new Date(contract.date) : null,
                dateModified: contract.dateModified
                  ? new Date(contract.dateModified)
                  : null,
                dateCreated: contract.dateCreated
                  ? new Date(contract.dateCreated)
                  : null,
                supplierEdrpou,
                supplierName,
                tenderId: tenderDetails.id,
              },
              create: {
                id: contract.id,
                contractID: contract.contractID || null,
                status: contract.status || null,
                amount,
                currency,
                valueAddedTaxIncluded: vatIncluded,
                amountNet,
                dateSigned: contract.dateSigned
                  ? new Date(contract.dateSigned)
                  : null,
                date: contract.date ? new Date(contract.date) : null,
                dateModified: contract.dateModified
                  ? new Date(contract.dateModified)
                  : null,
                dateCreated: contract.dateCreated
                  ? new Date(contract.dateCreated)
                  : null,
                supplierEdrpou,
                supplierName,
                tenderId: tenderDetails.id,
              },
            });

            contractsCount++; // Only count successfully saved contracts
          } catch (contractError) {
            // Don't fail the entire tender if one contract has issues
            hasFailedContracts = true;
            this.logger.warn(
              `Skipping contract ${contractRef.id} for tender ${tenderId}: ${contractError.message}`,
            );
          }
        }
      }

      // Update Tender status if there were failures
      if (hasFailedContracts) {
        this.partialCount++;
        await this.prisma.tender.update({
          where: { id: tenderDetails.id },
          data: { syncStatus: 'PARTIAL' },
        });
      }

      // Update aggregate counters (no per-tender log)
      this.processedTenders++;
      this.processedContracts += contractsCount;

      return {
        success: true,
        customers: customerEdrpou ? 1 : 0,
        suppliers: suppliers.size,
        contracts: contractsCount,
      };
    } catch (error) {
      this.errorCount++;
      this.logger.error(
        `Failed to process tender ${tenderId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
