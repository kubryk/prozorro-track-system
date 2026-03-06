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

  constructor(
    private readonly prisma: PrismaService,
    private readonly prozorroApi: ProzorroService,
    @InjectQueue('tender-processor') private readonly tenderQueue: Queue,
  ) { }

  async onApplicationBootstrap() {
    this.logger.log('SyncService initialized, checking initial offset...');
    // Example: You can set an initial offset here if the DB is empty
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
          this.logger.log('No more new tenders found in this cycle.');
          break;
        }

        this.logger.log(
          `Page ${pagesProcessed + 1}: Found ${data.length} tenders, offset: ${currentOffset || 'START'}`,
        );

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

      this.logger.log(
        `Sync cycle finished. Processed ${pagesProcessed} pages.`,
      );
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
}
