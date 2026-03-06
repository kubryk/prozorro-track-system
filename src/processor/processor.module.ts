import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { ProzorroModule } from '../prozorro/prozorro.module';
import { TenderProcessor } from './tender.processor/tender.processor';

@Module({
  imports: [
    PrismaModule,
    ProzorroModule,
    BullModule.registerQueue({
      name: 'tender-processor',
    }),
  ],
  providers: [TenderProcessor],
  exports: [TenderProcessor],
})
export class ProcessorModule {}
