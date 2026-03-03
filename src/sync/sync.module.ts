import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProzorroModule } from '../prozorro/prozorro.module';
import { BullModule } from '@nestjs/bullmq';
import { TenderProcessor } from '../processor/tender.processor/tender.processor';

@Module({
  imports: [
    PrismaModule,
    ProzorroModule,
    BullModule.registerQueue({
      name: 'tender-processor',
    })
  ],
  providers: [SyncService, TenderProcessor],
})
export class SyncModule { }
