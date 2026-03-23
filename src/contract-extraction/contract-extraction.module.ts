import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { ProzorroModule } from '../prozorro/prozorro.module';
import { CONTRACT_PRICE_EXTRACTION_QUEUE } from './contract-extraction.constants';
import { ContractExtractionService } from './contract-extraction.service';
import { ContractPriceExtractionProcessor } from './contract-price-extraction.processor';
import { ContractDocumentFetchService } from './contract-document-fetch.service';
import { ContractDocumentExtractionService } from './contract-document-extraction.service';
import { GeminiContractAuditService } from './gemini-contract-audit.service';
import { GeminiContractAiService } from './gemini-contract-ai.service';
import { MistralOcrService } from './mistral-ocr.service';
import { PdfTextExtractionService } from './pdf-text-extraction.service';
import { ContractPromptSettingsService } from './contract-prompt-settings.service';
import { ContractPromptSettingsController } from './contract-prompt-settings.controller';
import { ContractAnalysisController } from './contract-analysis.controller';
import { ContractUsageController } from './contract-usage.controller';

@Module({
  imports: [
    HttpModule,
    PrismaModule,
    ProzorroModule,
    BullModule.registerQueue({
      name: CONTRACT_PRICE_EXTRACTION_QUEUE,
    }),
  ],
  controllers: [
    ContractPromptSettingsController,
    ContractAnalysisController,
    ContractUsageController,
  ],
  providers: [
    ContractExtractionService,
    ContractPriceExtractionProcessor,
    ContractDocumentFetchService,
    ContractDocumentExtractionService,
    PdfTextExtractionService,
    MistralOcrService,
    ContractPromptSettingsService,
    GeminiContractAiService,
    GeminiContractAuditService,
  ],
})
export class ContractExtractionModule {}
