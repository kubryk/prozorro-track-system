import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ProzorroService } from '../prozorro/prozorro.service';

@Injectable()
export class SyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncService.name);
  private isSyncing = false;
  private addedCount = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly prozorroApi: ProzorroService,
    @InjectQueue('tender-processor') private readonly tenderQueue: Queue,
  ) {
    // Print sync stats every 30 seconds
    setInterval(async () => {
      if (process.env.APP_ROLE === 'WORKER') return;
      try {
        const counts = await this.tenderQueue.getJobCounts();
        if (this.addedCount === 0 && counts.waiting === 0) return;
        this.logger.log(
          `📥 За 30с: додано ${this.addedCount} тендерів у чергу | Черга: ${counts.waiting} очікують, ${counts.active} активних, ${counts.failed} помилок`,
        );
        this.addedCount = 0;
      } catch { /* ignore */ }
    }, 30_000);
  }

  async onApplicationBootstrap() {
    this.logger.log('SyncService initialized, checking initial offset...');
  }

  @Cron('* * * * * *') // Run every 1 second
  async handleSync() {
    // If this instance is only a worker, do not fetch new pages
    if (process.env.APP_ROLE === 'WORKER') return;

    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      let syncState = await this.prisma.syncState.findUnique({
        where: { id: 1 },
      });
      if (!syncState) {
        // Use SYNC_START_DATE as the initial offset (Prozorro accepts ISO date strings)
        const startOffset = process.env.SYNC_START_DATE || null;
        this.logger.log(
          `No sync state found. Starting from: ${startOffset || 'the very beginning'}`,
        );
        syncState = await this.prisma.syncState.create({
          data: { id: 1, lastOffset: startOffset },
        });
      }

      let currentOffset = syncState.lastOffset;
      let pagesProcessed = 0;
      const MAX_PAGES_PER_RUN = 1; // Fetch 1 page per run (100 tenders)

      while (pagesProcessed < MAX_PAGES_PER_RUN) {
        // 2. Fetch page from Prozorro
        const { data, nextPageOffset } = await this.prozorroApi.getTendersPage(
          currentOffset || undefined,
        );

        if (!data || data.length === 0) {
          break;
        }

        // 3. Add valid tenders to queue with retries
        for (const tender of data) {
          await this.tenderQueue.add(
            'process-tender',
            { tenderId: tender.id, dateModified: tender.dateModified },
            {
              jobId: tender.id, // Prevent duplicate jobs in queue
              attempts: 5, // Retry up to 5 times if fails
              backoff: {
                type: 'exponential',
                delay: 5000, // Delay increases: 5s, 10s, 20s...
              },
              removeOnComplete: true, // Keep Redis clean
              removeOnFail: false, // Keep failed ones for inspection
            },
          );
        }

        this.addedCount += data.length;

        // 4. Update local tracker and Database offset
        currentOffset = nextPageOffset;
        if (currentOffset) {
          await this.prisma.syncState.update({
            where: { id: 1 },
            data: { lastOffset: currentOffset },
          });
        }

        pagesProcessed++;

        // If the page was not full, we've likely caught up to real-time
        if (data.length < 100) break;
      }
    } catch (error) {
      this.logger.error('Error during synchronization loop', error.stack);
    } finally {
      this.isSyncing = false;
    }
  }

  // Run every 10 minutes to retry partially synced tenders
  @Cron('*/10 * * * *')
  async retryPartialTenders() {
    if (process.env.APP_ROLE === 'WORKER') return;

    this.logger.log('Checking for PARTIAL synced tenders to retry...');
    try {
      const partialTenders = await this.prisma.tender.findMany({
        where: { syncStatus: 'PARTIAL' },
        take: 100, // Process in batches
        orderBy: { dateModified: 'asc' }, // Oldest first
      });

      if (partialTenders.length === 0) {
        this.logger.log('No PARTIAL synced tenders found.');
        return;
      }

      this.logger.log(`Found ${partialTenders.length} PARTIAL tenders. Queuing for retry.`);

      for (const tender of partialTenders) {
        // We add them back to the queue. 
        // The processor will overwrite the existing DB records.
        await this.tenderQueue.add(
          'process-tender',
          { tenderId: tender.id, dateModified: tender.dateModified },
          {
            jobId: `retry-${tender.id}`, // Unique job ID for retries
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
          },
        );

        // Reset status to FULL so it's not picked up again until processed
        // If it fails again, the processor will flip it back to PARTIAL
        await this.prisma.tender.update({
          where: { id: tender.id },
          data: { syncStatus: 'FULL' }
        });
      }
    } catch (error) {
      this.logger.error('Error in retryPartialTenders cron', error.stack);
    }
  }

  async backfillTenders() {
    this.logger.log('🚀 Starting backfill for tenders missing advanced dates...');
    try {
      // Find tenders where new date fields are missing
      const tendersToBackfill = await this.prisma.tender.findMany({
        where: {
          tenderPeriodStart: null,
        } as any,
        select: {
          id: true,
          dateModified: true,
        },
      });

      if (tendersToBackfill.length === 0) {
        this.logger.log('✅ No tenders found missing advanced dates. Backfill not needed.');
        return { count: 0 };
      }

      this.logger.log(`📥 Found ${tendersToBackfill.length} tenders to backfill. Adding to queue...`);

      for (const tender of tendersToBackfill) {
        await this.tenderQueue.add(
          'process-tender',
          { tenderId: tender.id, dateModified: tender.dateModified },
          {
            jobId: `backfill-${tender.id}`, // Unique ID for backfill to avoid conflict with normal sync
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
          },
        );
      }

      this.logger.log('✅ All backfill jobs added to queue.');
      return { count: tendersToBackfill.length };
    } catch (error) {
      this.logger.error('❌ Error during backfill operation', error.stack);
      throw error;
    }
  }
}
