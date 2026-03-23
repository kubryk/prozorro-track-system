import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProzorroService } from '../prozorro/prozorro.service';
import { CONTRACT_PRICE_EXTRACTION_QUEUE } from './contract-extraction.constants';
import { ContractExtractionService } from './contract-extraction.service';
import {
  ContractExtractionResult,
  ExtractedDocumentResult,
  ExtractionJobPayload,
} from './contract-extraction.types';
import { selectRelevantContractDocuments } from './contract-extraction.utils';
import { ContractDocumentExtractionService } from './contract-document-extraction.service';
import { summarizeUsageMetrics } from './contract-usage.utils';

function parsePositiveIntEnv(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value || '', 10);

  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

@Processor(CONTRACT_PRICE_EXTRACTION_QUEUE, {
  concurrency: parsePositiveIntEnv(
    process.env.CONTRACT_EXTRACTION_CONCURRENCY,
    2,
  ),
})
export class ContractPriceExtractionProcessor extends WorkerHost {
  private readonly logger = new Logger(ContractPriceExtractionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prozorroService: ProzorroService,
    private readonly contractDocumentExtractionService: ContractDocumentExtractionService,
    private readonly contractExtractionService: ContractExtractionService,
  ) {
    super();
  }

  async process(
    job: Job<ExtractionJobPayload, ContractExtractionResult>,
  ): Promise<ContractExtractionResult> {
    await this.contractExtractionService.markRunProcessing(
      job.data.extractionRunId,
      String(job.id),
    );

    try {
      const contract = await this.prisma.contract.findUnique({
        where: { id: job.data.contractDbId },
        include: {
          tender: {
            select: {
              tenderID: true,
            },
          },
        },
      });

      if (!contract) {
        throw new NotFoundException(
          `Contract not found for extraction: ${job.data.contractDbId}`,
        );
      }

      const contractDetails = await this.prozorroService.getContractDetails(
        contract.tenderId,
        contract.id,
      );
      const sourceDocuments = Array.isArray(contractDetails?.documents)
        ? contractDetails.documents
        : [];

      let result: ContractExtractionResult;

      if (sourceDocuments.length === 0) {
        result = this.buildResult(contract, 'no_contract_documents', [], 0, 0);
      } else {
        const relevantDocuments = selectRelevantContractDocuments(sourceDocuments);

        if (relevantDocuments.length === 0) {
          result = this.buildResult(
            contract,
            'no_relevant_documents',
            [],
            sourceDocuments.length,
            0,
          );
        } else {
          const maxDocuments = parsePositiveIntEnv(
            process.env.CONTRACT_EXTRACTION_MAX_DOCUMENTS,
            3,
          );
          const processedDocuments: ExtractedDocumentResult[] = [];

          for (const document of relevantDocuments.slice(0, maxDocuments)) {
            try {
              const extraction =
                await this.contractDocumentExtractionService.extract(document);

              processedDocuments.push(extraction);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : 'Unknown extraction error';

              processedDocuments.push({
                title: document.title,
                url: document.url,
                mimeType: document.mimeType,
                matchedKeywords: document.matchedKeywords,
                extractionMethod: null,
                extractedText: null,
                candidatePages: null,
                tables: [],
                usage: null,
                error: message,
              });
            }
          }

          const extractedTextsCount = processedDocuments.reduce(
            (sum, document) => sum + (document.extractedText ? 1 : 0),
            0,
          );
          const requiresMistralConfig =
            processedDocuments.length > 0 &&
            processedDocuments.every((document) =>
              String(document.error || '').includes(
                'Mistral OCR is not configured',
              ),
            );
          const status =
            requiresMistralConfig
              ? 'requires_mistral_config'
              : extractedTextsCount > 0
                ? 'completed_text'
                : 'completed_no_tables';

          result = this.buildResult(
            contract,
            status,
            processedDocuments,
            sourceDocuments.length,
            relevantDocuments.length,
          );
        }
      }

      await this.contractExtractionService.persistRunResult(
        job.data.extractionRunId,
        result,
      );
      void this.runPostExtractionPipeline(contract.id);

      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown extraction error';

      await this.contractExtractionService.markRunFailed(
        job.data.extractionRunId,
        message,
      );

      throw error;
    }
  }

  private async runPostExtractionPipeline(contractRef: string): Promise<void> {
    try {
      await this.contractExtractionService.runContractAiExtraction(contractRef);
    } catch (error) {
      this.logger.warn(
        `Auto AI extraction failed for contract ${contractRef}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }

    try {
      await this.contractExtractionService.runContractAiAudit(contractRef);
    } catch (error) {
      this.logger.warn(
        `Auto AI audit failed for contract ${contractRef}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  private buildResult(
    contract: {
      id: string;
      contractID: string | null;
      tenderId: string;
      tender?: { tenderID: string | null } | null;
    },
    status: ContractExtractionResult['status'],
    documents: ExtractedDocumentResult[],
    totalDocuments: number,
    relevantDocuments: number,
  ): ContractExtractionResult {
    return {
      status,
      contract: {
        id: contract.id,
        contractID: contract.contractID,
        tenderId: contract.tenderId,
        tenderPublicId: contract.tender?.tenderID ?? null,
      },
      totalDocuments,
      relevantDocuments,
      processedDocuments: documents.length,
      documents,
      usageSummary: summarizeUsageMetrics(
        documents.map((document) => document.usage),
      ),
    };
  }
}
