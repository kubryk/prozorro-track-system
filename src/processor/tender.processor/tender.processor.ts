import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProzorroService } from '../../prozorro/prozorro.service';

const STATS_INTERVAL_MS = 30_000; // Print summary every 30 seconds
const DEFAULT_WORKER_CONCURRENCY = 50;
const DEFAULT_WORKER_DB_CONCURRENCY = 2;
const DEFAULT_WORKER_LOCK_DURATION_MS = 300_000;

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);

  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

/** Safely parse a value to Float — Prozorro API sometimes returns numbers as strings */
function toFloat(val: any): number | null {
  if (val == null) return null;
  const n = typeof val === 'string' ? parseFloat(val) : val;
  return isNaN(n) ? null : n;
}

@Processor('tender-processor', {
  // concurrency — скільки задач BullMQ тримає одночасно в пам'яті.
  // Реальний ліміт запитів до API — в ProzorroService (WORKER_REQUESTS_PER_SECOND)
  concurrency: parsePositiveIntEnv(
    process.env.WORKER_CONCURRENCY,
    DEFAULT_WORKER_CONCURRENCY,
  ),
  // BullMQ lock must outlive slower tenders; otherwise a long-running job can
  // lose its lock and then fail on moveToFinished/moveToDelayed.
  lockDuration: parsePositiveIntEnv(
    process.env.WORKER_LOCK_DURATION_MS,
    DEFAULT_WORKER_LOCK_DURATION_MS,
  ),
})
export class TenderProcessor extends WorkerHost {
  private readonly logger = new Logger(TenderProcessor.name);
  private readonly maxDbWriteConcurrency = parsePositiveIntEnv(
    process.env.WORKER_DB_CONCURRENCY,
    DEFAULT_WORKER_DB_CONCURRENCY,
  );
  private activeDbWriteSlots = 0;
  private readonly pendingDbWriteWaiters: Array<() => void> = [];

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

  private async acquireDbWriteSlot(): Promise<void> {
    if (this.activeDbWriteSlots < this.maxDbWriteConcurrency) {
      this.activeDbWriteSlots++;
      return;
    }

    await new Promise<void>((resolve) => {
      this.pendingDbWriteWaiters.push(resolve);
    });
    this.activeDbWriteSlots++;
  }

  private releaseDbWriteSlot(): void {
    this.activeDbWriteSlots--;
    const nextWaiter = this.pendingDbWriteWaiters.shift();
    if (nextWaiter) {
      nextWaiter();
    }
  }

  private async withDbWriteSlot<T>(work: () => Promise<T>): Promise<T> {
    await this.acquireDbWriteSlot();
    try {
      return await work();
    } finally {
      this.releaseDbWriteSlot();
    }
  }

  async process(
    job: Job<{ tenderId: string; dateModified?: string | Date }, any, string>,
  ): Promise<any> {
    const { tenderId } = job.data;

    try {
      const tenderDetails = await this.prozorroApi.getTenderDetails(tenderId);

      if (!tenderDetails) {
        throw new Error(`No details found for tender: ${tenderId}`);
      }

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

      // Helper to parse Prozorro dates
      const pDate = (d: any) => d ? new Date(d) : null;
      const fallbackDateModified = job.data.dateModified
        ? new Date(job.data.dateModified)
        : new Date();
      const safeFallbackDateModified = Number.isNaN(fallbackDateModified.getTime())
        ? new Date()
        : fallbackDateModified;
      const tenderDateModified = pDate(tenderDetails.dateModified) ?? safeFallbackDateModified;
      const tenderDateCreated = pDate(tenderDetails.dateCreated) ?? tenderDateModified;
      const tenderYear = tenderDateModified.getFullYear();

      const contractRefs = Array.isArray(tenderDetails.contracts)
        ? tenderDetails.contracts
        : null;
      const expectedContractIds: string[] = [];
      if (contractRefs) {
        for (const contractRef of contractRefs) {
          if (
            typeof contractRef?.id === 'string' &&
            !expectedContractIds.includes(contractRef.id)
          ) {
            expectedContractIds.push(contractRef.id);
          }
        }
      }

      // Save Contracts (with separate API call for full details)
      let contractsCount = 0;
      let hasFailedContracts = false;
      const contractDetailsToPersist: any[] = [];
      if (contractRefs) {
        for (const contractRef of contractRefs) {
          try {
            // Fetch full contract details from a separate API endpoint
            const contract = await this.prozorroApi.getContractDetails(
              tenderId,
              contractRef.id,
            );
            if (!contract) continue;

            contractDetailsToPersist.push(contract);
          } catch (contractError) {
            // Don't fail the entire tender if one contract has issues
            hasFailedContracts = true;
            this.logger.warn(
              `Skipping contract ${contractRef.id} for tender ${tenderId}: ${contractError.message}`,
            );
          }
        }
      }
      contractsCount = contractDetailsToPersist.length;

      const deletedContracts = await this.withDbWriteSlot(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.tender.upsert({
            where: { id: tenderDetails.id },
            update: {
              tenderID: tenderDetails.tenderID,
              title: tenderDetails.title || null,
              status: tenderDetails.status,
              amount: toFloat(tenderDetails.value?.amount),
              currency: tenderDetails.value?.currency || null,
              year: tenderYear,
              dateModified: tenderDateModified,
              dateCreated: tenderDateCreated,
              tenderPeriodStart: pDate(tenderDetails.tenderPeriod?.startDate),
              tenderPeriodEnd: pDate(tenderDetails.tenderPeriod?.endDate),
              enquiryPeriodStart: pDate(tenderDetails.enquiryPeriod?.startDate),
              enquiryPeriodEnd: pDate(tenderDetails.enquiryPeriod?.endDate),
              auctionPeriodStart: pDate(tenderDetails.auctionPeriod?.startDate),
              awardPeriodStart: pDate(tenderDetails.awardPeriod?.startDate),
              customerEdrpou,
              customerName,
              syncStatus: 'FULL',
            },
            create: {
              id: tenderDetails.id,
              tenderID: tenderDetails.tenderID,
              title: tenderDetails.title || null,
              status: tenderDetails.status,
              amount: toFloat(tenderDetails.value?.amount),
              currency: tenderDetails.value?.currency || null,
              year: tenderYear,
              dateModified: tenderDateModified,
              dateCreated: tenderDateCreated,
              tenderPeriodStart: pDate(tenderDetails.tenderPeriod?.startDate),
              tenderPeriodEnd: pDate(tenderDetails.tenderPeriod?.endDate),
              enquiryPeriodStart: pDate(tenderDetails.enquiryPeriod?.startDate),
              enquiryPeriodEnd: pDate(tenderDetails.enquiryPeriod?.endDate),
              auctionPeriodStart: pDate(tenderDetails.auctionPeriod?.startDate),
              awardPeriodStart: pDate(tenderDetails.awardPeriod?.startDate),
              customerEdrpou,
              customerName,
              syncStatus: 'FULL',
            },
          });

          for (const contract of contractDetailsToPersist) {
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

            if (
              contract.suppliers &&
              Array.isArray(contract.suppliers) &&
              contract.suppliers.length > 0
            ) {
              const supplier = contract.suppliers[0];
              supplierEdrpou = supplier.identifier?.id || null;
              supplierName = supplier.name || supplier.identifier?.legalName || null;
            }

            await tx.contract.upsert({
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
          }

          const deleteWhere: Prisma.ContractWhereInput =
            expectedContractIds.length > 0
              ? {
                  tenderId: tenderDetails.id,
                  id: { notIn: expectedContractIds },
                }
              : { tenderId: tenderDetails.id };

          const { count: deletedContractsCount } = await tx.contract.deleteMany({
            where: deleteWhere,
          });

          if (hasFailedContracts) {
            this.partialCount++;
            await tx.tender.update({
              where: { id: tenderDetails.id },
              data: { syncStatus: 'PARTIAL' },
            });
          }

          return deletedContractsCount;
        }),
      );

      if (deletedContracts > 0) {
        this.logger.log(
          `Removed ${deletedContracts} stale contracts for tender ${tenderId}`,
        );
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
      const fallbackDateModified = job.data.dateModified
        ? new Date(job.data.dateModified)
        : new Date();
      const safeDateModified = Number.isNaN(fallbackDateModified.getTime())
        ? new Date()
        : fallbackDateModified;

      await this.withDbWriteSlot(() =>
        this.prisma.tender.upsert({
          where: { id: tenderId },
          update: {
            year: safeDateModified.getFullYear(),
            dateModified: safeDateModified,
            syncStatus: 'FAILED',
          },
          create: {
            id: tenderId,
            year: safeDateModified.getFullYear(),
            dateModified: safeDateModified,
            syncStatus: 'FAILED',
          },
        }),
      );
      this.logger.error(
        `Failed to process tender ${tenderId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
