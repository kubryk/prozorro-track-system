import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { ProzorroModule } from './prozorro/prozorro.module';
import { SyncModule } from './sync/sync.module';
import { ProcessorModule } from './processor/processor.module';
import { SearchModule } from './search/search.module';
import { AuthModule } from './auth/auth.module';
import { ContractExtractionModule } from './contract-extraction/contract-extraction.module';
import { CONTRACT_PRICE_EXTRACTION_QUEUE } from './contract-extraction/contract-extraction.constants';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
      },
    }),
    BullBoardModule.forRoot({
      route: '/queues',
      adapter: ExpressAdapter,
    }),
    BullModule.registerQueue({
      name: 'tender-processor',
    }),
    BullModule.registerQueue({
      name: CONTRACT_PRICE_EXTRACTION_QUEUE,
    }),
    BullBoardModule.forFeature({
      name: 'tender-processor',
      adapter: BullMQAdapter,
    }),
    BullBoardModule.forFeature({
      name: CONTRACT_PRICE_EXTRACTION_QUEUE,
      adapter: BullMQAdapter,
    }),
    PrismaModule,
    ProzorroModule,
    SyncModule,
    SearchModule,
    ContractExtractionModule,
    ProcessorModule, // Import the processor module as well so the worker starts
    AuthModule, // Global Auth guard
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
