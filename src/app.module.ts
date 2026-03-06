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
    BullBoardModule.forFeature({
      name: 'tender-processor',
      adapter: BullMQAdapter,
    }),
    PrismaModule,
    ProzorroModule,
    SyncModule,
    SearchModule,
    ProcessorModule, // Import the processor module as well so the worker starts
    AuthModule, // Global Auth guard
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
