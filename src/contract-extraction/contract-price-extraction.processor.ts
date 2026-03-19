import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProzorroService } from '../prozorro/prozorro.service';
import { CONTRACT_PRICE_EXTRACTION_QUEUE } from './contract-extraction.constants';
import {
  ContractExtractionResult,
  ExtractedDocumentResult,
  ExtractionJobPayload,
} from './contract-extraction.types';
import { selectRelevantContractDocuments } from './contract-extraction.utils';
import { GoogleDocumentAiService } from './google-document-ai.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly prozorroService: ProzorroService,
    private readonly googleDocumentAiService: GoogleDocumentAiService,
  ) {
    super();
  }

  async process(
    job: Job<ExtractionJobPayload, ContractExtractionResult>,
  ): Promise<ContractExtractionResult> {
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

    if (sourceDocuments.length === 0) {
      return this.buildResult(contract, 'no_contract_documents', [], 0, 0);
    }

    const relevantDocuments = selectRelevantContractDocuments(sourceDocuments);

    if (relevantDocuments.length === 0) {
      return this.buildResult(
        contract,
        'no_relevant_documents',
        [],
        sourceDocuments.length,
        0,
      );
    }

    if (!this.googleDocumentAiService.isConfigured()) {
      return this.buildResult(
        contract,
        'requires_google_config',
        relevantDocuments.map((document) => ({
          title: document.title,
          url: document.url,
          mimeType: document.mimeType,
          matchedKeywords: document.matchedKeywords,
          candidatePages: null,
          tables: [],
          error:
            'Google Document AI is not configured. Set GOOGLE_CLOUD_PROJECT_ID, GOOGLE_DOCUMENT_AI_LOCATION, GOOGLE_DOCUMENT_AI_FORM_PROCESSOR_ID and credentials.',
        })),
        sourceDocuments.length,
        relevantDocuments.length,
      );
    }

    const maxDocuments = parsePositiveIntEnv(
      process.env.CONTRACT_EXTRACTION_MAX_DOCUMENTS,
      3,
    );
    const processedDocuments: ExtractedDocumentResult[] = [];

    for (const document of relevantDocuments.slice(0, maxDocuments)) {
      try {
        const extraction = await this.googleDocumentAiService.extractPriceTablesFromUrl(
          document,
        );

        processedDocuments.push({
          title: document.title,
          url: document.url,
          mimeType: document.mimeType,
          matchedKeywords: document.matchedKeywords,
          candidatePages: extraction.candidatePages,
          tables: extraction.tables,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown extraction error';

        processedDocuments.push({
          title: document.title,
          url: document.url,
          mimeType: document.mimeType,
          matchedKeywords: document.matchedKeywords,
          candidatePages: null,
          tables: [],
          error: message,
        });
      }
    }

    const extractedTablesCount = processedDocuments.reduce(
      (sum, document) => sum + document.tables.length,
      0,
    );
    const status =
      extractedTablesCount > 0 ? 'completed' : 'completed_no_tables';

    return this.buildResult(
      contract,
      status,
      processedDocuments,
      sourceDocuments.length,
      relevantDocuments.length,
    );
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
    };
  }
}
