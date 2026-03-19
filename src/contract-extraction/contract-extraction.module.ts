import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { ProzorroModule } from '../prozorro/prozorro.module';
import { CONTRACT_PRICE_EXTRACTION_QUEUE } from './contract-extraction.constants';
import { ContractExtractionController } from './contract-extraction.controller';
import { ContractExtractionService } from './contract-extraction.service';
import { ContractPriceExtractionProcessor } from './contract-price-extraction.processor';
import { GoogleDocumentAiService } from './google-document-ai.service';

@Module({
  imports: [
    HttpModule,
    PrismaModule,
    ProzorroModule,
    BullModule.registerQueue({
      name: CONTRACT_PRICE_EXTRACTION_QUEUE,
    }),
  ],
  controllers: [ContractExtractionController],
  providers: [
    ContractExtractionService,
    ContractPriceExtractionProcessor,
    GoogleDocumentAiService,
  ],
})
export class ContractExtractionModule {}
