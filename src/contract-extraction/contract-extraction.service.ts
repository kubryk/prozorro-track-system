import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ProzorroService } from '../prozorro/prozorro.service';
import { CONTRACT_PRICE_EXTRACTION_QUEUE } from './contract-extraction.constants';
import { resolveContractItems } from './contract-item-resolution.utils';
import { GeminiContractAuditService } from './gemini-contract-audit.service';
import { GeminiContractAiService } from './gemini-contract-ai.service';
import {
  ContractAiAuditResult,
  ContractAiAuditStatusResponse,
  ContractAiExtractionResult,
  ContractAiExtractionStatusResponse,
  ContractAuditReportDocument,
  ContractExtractionResult,
  ContractExtractionStatusResponse,
  ContractUsageOverview,
  ContractUsageSummary,
  ExtractionJobPayload,
} from './contract-extraction.types';
import {
  buildGeminiUsageMetric,
  mergeUsageSummaries,
  parseStoredUsageMetric,
  parseStoredUsageSummary,
  summarizeUsageMetrics,
} from './contract-usage.utils';

@Injectable()
export class ContractExtractionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prozorroService: ProzorroService,
    private readonly geminiContractAiService: GeminiContractAiService,
    private readonly geminiContractAuditService: GeminiContractAuditService,
    @InjectQueue(CONTRACT_PRICE_EXTRACTION_QUEUE)
    private readonly extractionQueue: Queue<
      ExtractionJobPayload,
      ContractExtractionResult
    >,
  ) {}

  async queueContractExtraction(
    contractRef: string,
  ): Promise<ContractExtractionStatusResponse> {
    const contract = await this.resolveContract(contractRef);
    const latestRun = await this.getLatestRun(contract.id);
    const activeJob = await this.getContractJob(contract.id, latestRun?.jobId);

    if (activeJob) {
      const state = await activeJob.getState();

      if (state === 'waiting' || state === 'active' || state === 'delayed') {
        return this.mapJobStatus(activeJob, contract, latestRun);
      }

      if (state === 'completed' || state === 'failed') {
        await activeJob.remove();
      }
    }

    const run = await this.prisma.contractExtractionRun.create({
      data: {
        contractId: contract.id,
        state: 'queued',
      },
    });
    const jobId = this.buildJobId(contract.id, run.id);
    const job = await this.extractionQueue.add(
      'extract-selected-contract',
      { contractDbId: contract.id, extractionRunId: run.id },
      {
        jobId,
        removeOnComplete: 20,
        removeOnFail: 20,
      },
    );

    const persistedRun = await this.prisma.contractExtractionRun.update({
      where: { id: run.id },
      data: {
        jobId: String(job.id),
      },
    });

    return this.mapJobStatus(job, contract, persistedRun);
  }

  async getContractExtractionStatus(
    contractRef: string,
  ): Promise<ContractExtractionStatusResponse> {
    const contract = await this.resolveContract(contractRef);
    const latestRun = await this.getLatestRun(contract.id);
    const job = await this.getContractJob(contract.id, latestRun?.jobId);

    if (job) {
      return this.mapJobStatus(job, contract, latestRun);
    }

    if (latestRun) {
      return this.mapPersistedRunStatus(contract, latestRun);
    }

    return {
      contract: this.toContractSummary(contract),
      runId: null,
      jobId: null,
      state: 'idle',
      result: null,
      failureReason: null,
      attemptsMade: 0,
      timestamp: null,
      finishedOn: null,
    };
  }

  async getContractDetail(contractRef: string) {
    const contract = await this.prisma.contract.findFirst({
      where: {
        OR: [{ id: contractRef }, { contractID: contractRef }],
      },
      include: {
        tender: {
          select: {
            id: true,
            tenderID: true,
            title: true,
            status: true,
            amount: true,
            currency: true,
            dateCreated: true,
            dateModified: true,
            customerEdrpou: true,
            customerName: true,
          },
        },
      },
    });

    if (!contract) {
      throw new NotFoundException(`Contract not found: ${contractRef}`);
    }

    const latestRun = await this.getLatestRun(contract.id);
    const latestExtraction = latestRun
      ? this.mapPersistedRunStatus(contract, latestRun)
      : null;
    const latestAiRun = await this.getLatestAiRun(contract.id);
    const latestAiExtraction = latestAiRun
      ? this.mapPersistedAiRunStatus(contract, latestAiRun)
      : null;
    const latestAiAuditRun = await this.getLatestAiAuditRun(contract.id);
    const latestAiAudit = latestAiAuditRun
      ? this.mapPersistedAiAuditStatus(contract, latestAiAuditRun)
      : null;
    const processingUsage = this.buildContractUsageOverview(
      latestExtraction?.result ?? null,
      latestAiExtraction?.result ?? null,
      latestAiAudit?.result ?? null,
    );
    const sourceDetails = await this.getSourceContractDetails(contract.id, contract.tenderId);
    const sourceContract = sourceDetails.sourceContract as Record<string, any> | null;
    const sourceItems = Array.isArray(sourceContract?.items)
      ? (sourceContract.items as Record<string, unknown>[])
      : [];
    const resolvedItems = resolveContractItems(
      sourceItems,
      latestExtraction?.result ?? null,
      sourceContract?.value?.currency ??
        contract.currency ??
        contract.tender?.currency ??
        null,
    );

    return {
      contract: {
        id: contract.id,
        contractID: contract.contractID,
        status: contract.status,
        amount: contract.amount,
        currency: contract.currency,
        valueAddedTaxIncluded: contract.valueAddedTaxIncluded,
        amountNet: contract.amountNet,
        dateSigned: contract.dateSigned,
        date: contract.date,
        dateModified: contract.dateModified,
        dateCreated: contract.dateCreated,
        supplierEdrpou: contract.supplierEdrpou,
        supplierName: contract.supplierName,
        tenderId: contract.tenderId,
      },
      tender: contract.tender,
      sourceContract,
      resolvedItems,
      sourceDocuments: sourceDetails.documents,
      sourceChanges: sourceDetails.changes,
      sourceMilestones: sourceDetails.milestones,
      latestExtraction,
      latestAiExtraction,
      latestAiAudit,
      processingUsage,
    };
  }

  async getContractUsage(contractRef: string): Promise<{
    contract: {
      id: string;
      contractID: string | null;
      tenderId: string;
      tenderPublicId: string | null;
    };
    usage: ContractUsageOverview;
  }> {
    const contract = await this.resolveContract(contractRef);
    const latestRun = await this.getLatestRun(contract.id);
    const latestExtraction = latestRun
      ? this.mapPersistedRunStatus(contract, latestRun)
      : null;
    const latestAiRun = await this.getLatestAiRun(contract.id);
    const latestAiExtraction = latestAiRun
      ? this.mapPersistedAiRunStatus(contract, latestAiRun)
      : null;
    const latestAiAuditRun = await this.getLatestAiAuditRun(contract.id);
    const latestAiAudit = latestAiAuditRun
      ? this.mapPersistedAiAuditStatus(contract, latestAiAuditRun)
      : null;

    return {
      contract: this.toContractSummary(contract),
      usage: this.buildContractUsageOverview(
        latestExtraction?.result ?? null,
        latestAiExtraction?.result ?? null,
        latestAiAudit?.result ?? null,
      ),
    };
  }

  async runContractAiExtraction(
    contractRef: string,
  ): Promise<ContractAiExtractionStatusResponse> {
    const contract = await this.resolveContract(contractRef);
    const latestRun = await this.getLatestRun(contract.id);
    const processingRun = await this.prisma.contractAiExtractionRun.findFirst({
      where: {
        contractId: contract.id,
        state: 'processing',
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        contract: {
          include: {
            tender: {
              select: {
                tenderID: true,
              },
            },
          },
        },
      },
    });

    if (processingRun) {
      return this.mapPersistedAiRunStatus(contract, processingRun);
    }

    const run = await this.prisma.contractAiExtractionRun.create({
      data: {
        contractId: contract.id,
        state: 'processing',
        model: this.geminiContractAiService.getModel(),
        startedAt: new Date(),
      },
      include: {
        contract: {
          include: {
            tender: {
              select: {
                tenderID: true,
              },
            },
          },
        },
      },
    });

    try {
      if (!latestRun) {
        const persisted = await this.prisma.contractAiExtractionRun.update({
          where: { id: run.id },
          data: {
            state: 'no_extracted_text',
            error: null,
            documentsAnalyzed: 0,
            itemsExtracted: 0,
            sourceTextLength: 0,
            finishedAt: new Date(),
          },
          include: {
            contract: {
              include: {
                tender: {
                  select: {
                    tenderID: true,
                  },
                },
              },
            },
          },
        });

        return this.mapPersistedAiRunStatus(contract, persisted);
      }

      const sourceDocuments = Array.isArray(latestRun.documents)
        ? latestRun.documents
            .map((document: any) => ({
              title: document.title,
              extractionMethod:
                document.extractionMethod === 'pdf-text' ||
                document.extractionMethod === 'mistral-ocr'
                  ? document.extractionMethod
                  : null,
              extractedText:
                typeof document.extractedText === 'string'
                  ? document.extractedText
                  : '',
            }))
            .filter((document: any) => document.extractedText.trim().length > 0)
        : [];
      let sourceContractItems: Record<string, unknown>[] = [];

      try {
        const sourceContractDetails = await this.prozorroService.getContractDetails(
          contract.tenderId,
          contract.id,
        );
        sourceContractItems = Array.isArray(sourceContractDetails?.items)
          ? sourceContractDetails.items
          : [];
      } catch {
        sourceContractItems = [];
      }

      if (sourceDocuments.length === 0) {
        const persisted = await this.prisma.contractAiExtractionRun.update({
          where: { id: run.id },
          data: {
            state: 'no_extracted_text',
            error: null,
            documentsAnalyzed: 0,
            itemsExtracted: 0,
            sourceTextLength: 0,
            finishedAt: new Date(),
          },
          include: {
            contract: {
              include: {
                tender: {
                  select: {
                    tenderID: true,
                  },
                },
              },
            },
          },
        });

        return this.mapPersistedAiRunStatus(contract, persisted);
      }

      if (!this.geminiContractAiService.isConfigured()) {
        const persisted = await this.prisma.contractAiExtractionRun.update({
          where: { id: run.id },
          data: {
            state: 'requires_gemini_config',
            error: null,
            documentsAnalyzed: sourceDocuments.length,
            itemsExtracted: 0,
            sourceTextLength: sourceDocuments.reduce(
              (sum: number, document: any) => sum + document.extractedText.length,
              0,
            ),
            finishedAt: new Date(),
          },
          include: {
            contract: {
              include: {
                tender: {
                  select: {
                    tenderID: true,
                  },
                },
              },
            },
          },
        });

        return this.mapPersistedAiRunStatus(contract, persisted);
      }

      const result = await this.geminiContractAiService.extractItems({
        contract: {
          ...this.toContractSummary(contract),
          currency: contract.currency,
        },
        documents: sourceDocuments,
        apiItems: sourceContractItems,
      });
      const documentDerivedItems = this.countDocumentDerivedAiItems(result.items);
      const aiExtractionState =
        result.items.length === 0
          ? 'completed_no_items'
          : documentDerivedItems > 0
            ? 'completed'
            : 'completed_api_fallback_only';
      const persisted = await this.prisma.contractAiExtractionRun.update({
        where: { id: run.id },
        data: {
          state: aiExtractionState,
          error: null,
          model: result.model,
          documentsAnalyzed: result.documentsAnalyzed,
          itemsExtracted: result.items.length,
          sourceTextLength: result.sourceTextLength,
          items: result.items as unknown as Prisma.InputJsonValue,
          usage: result.usage
            ? (result.usage as unknown as Prisma.InputJsonValue)
            : undefined,
          rawResponse: result.rawResponse
            ? (result.rawResponse as Prisma.InputJsonValue)
            : undefined,
          finishedAt: new Date(),
        },
        include: {
          contract: {
            include: {
              tender: {
                select: {
                  tenderID: true,
                },
              },
            },
          },
        },
      });

      return this.mapPersistedAiRunStatus(contract, persisted);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown Gemini extraction error';

      await this.prisma.contractAiExtractionRun.update({
        where: { id: run.id },
        data: {
          state: 'failed',
          error: message,
          finishedAt: new Date(),
        },
      });

      throw error;
    }
  }

  async getContractAiExtractionStatus(
    contractRef: string,
  ): Promise<ContractAiExtractionStatusResponse> {
    const contract = await this.resolveContract(contractRef);
    const latestRun = await this.getLatestAiRun(contract.id);

    if (latestRun) {
      return this.mapPersistedAiRunStatus(contract, latestRun);
    }

    return {
      contract: this.toContractSummary(contract),
      runId: null,
      state: 'idle',
      result: null,
      failureReason: null,
      timestamp: null,
      finishedOn: null,
    };
  }

  async runContractAiAudit(
    contractRef: string,
  ): Promise<ContractAiAuditStatusResponse> {
    const contract = await this.resolveContract(contractRef);
    const latestExtraction = await this.getLatestAiRun(contract.id);
    const latestDocumentRun = await this.getLatestRun(contract.id);
    let suppliers = contract.supplierName ? [contract.supplierName] : [];
    let providedDocuments = Array.isArray(latestDocumentRun?.documents)
      ? latestDocumentRun.documents
          .map((document: any) => this.formatProvidedDocumentSummary(document))
          .filter((item: string | null): item is string => Boolean(item))
      : [];

    try {
      const sourceDetails = await this.getSourceContractDetails(
        contract.id,
        contract.tenderId,
      );
      const sourceDocumentTitles = Array.isArray(sourceDetails.documents)
        ? sourceDetails.documents
            .map((document: any) =>
              typeof document?.title === 'string' ? document.title.trim() : '',
            )
            .filter(Boolean)
        : [];

      if (sourceDocumentTitles.length > 0) {
        const existingDocumentKeys = new Set(
          providedDocuments.map((item: string) =>
            this.normalizeDocumentTitleKey(item),
          ),
        );
        const missingSourceDocuments = sourceDocumentTitles.filter(
          (title) =>
            !existingDocumentKeys.has(this.normalizeDocumentTitleKey(title)),
        );

        providedDocuments = [...providedDocuments, ...missingSourceDocuments];
      }

      const sourceSuppliers =
        sourceDetails.sourceContract &&
        typeof sourceDetails.sourceContract === 'object' &&
        Array.isArray((sourceDetails.sourceContract as any).suppliers)
          ? (sourceDetails.sourceContract as any).suppliers
              .map((supplier: any) =>
                typeof supplier?.name === 'string' ? supplier.name.trim() : '',
              )
              .filter(Boolean)
          : [];

      if (sourceSuppliers.length > 0) {
        suppliers = sourceSuppliers;
      }
    } catch {
      // Keep audit resilient and fall back to the latest processed document titles.
    }

    const processingRun = await this.prisma.contractAiAuditRun.findFirst({
      where: {
        contractId: contract.id,
        state: 'processing',
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        contract: {
          include: {
            tender: {
              select: {
                tenderID: true,
                customerName: true,
                title: true,
              },
            },
          },
        },
      },
    });

    if (processingRun) {
      return this.mapPersistedAiAuditStatus(contract, processingRun);
    }

    const run = await this.prisma.contractAiAuditRun.create({
      data: {
        contractId: contract.id,
        state: 'processing',
        model: this.geminiContractAuditService.getModel(),
        startedAt: new Date(),
      },
      include: {
        contract: {
          include: {
            tender: {
              select: {
                tenderID: true,
                customerName: true,
                title: true,
              },
            },
          },
        },
      },
    });

    try {
      const extractedItems = Array.isArray(latestExtraction?.items)
        ? latestExtraction.items
        : [];
      const documentDerivedItems = extractedItems.filter((item: any) =>
        this.isDocumentDerivedAiItem(item),
      );

      if (extractedItems.length === 0) {
        const persisted = await this.prisma.contractAiAuditRun.update({
          where: { id: run.id },
          data: {
            state: 'no_items_to_audit',
            error: null,
            itemsAudited: 0,
            flaggedItemsCount: 0,
            overallRiskLevel: 'unknown',
            overallScore: null,
            summary: null,
            finishedAt: new Date(),
          },
          include: {
            contract: {
              include: {
                tender: {
                  select: {
                    tenderID: true,
                    customerName: true,
                    title: true,
                  },
                },
              },
            },
          },
        });

        return this.mapPersistedAiAuditStatus(contract, persisted);
      }

      if (documentDerivedItems.length === 0) {
        const persisted = await this.prisma.contractAiAuditRun.update({
          where: { id: run.id },
          data: {
            state: 'no_document_items_to_audit',
            error: null,
            itemsAudited: 0,
            flaggedItemsCount: 0,
            overallRiskLevel: 'unknown',
            overallScore: null,
            summary: null,
            finishedAt: new Date(),
          },
          include: {
            contract: {
              include: {
                tender: {
                  select: {
                    tenderID: true,
                    customerName: true,
                    title: true,
                  },
                },
              },
            },
          },
        });

        return this.mapPersistedAiAuditStatus(contract, persisted);
      }

      if (!this.geminiContractAuditService.isConfigured()) {
        const persisted = await this.prisma.contractAiAuditRun.update({
          where: { id: run.id },
          data: {
            state: 'requires_gemini_config',
            error: null,
            itemsAudited: extractedItems.length,
            flaggedItemsCount: 0,
            overallRiskLevel: 'unknown',
            overallScore: null,
            summary: null,
            finishedAt: new Date(),
          },
          include: {
            contract: {
              include: {
                tender: {
                  select: {
                    tenderID: true,
                    customerName: true,
                    title: true,
                  },
                },
              },
            },
          },
        });

        return this.mapPersistedAiAuditStatus(contract, persisted);
      }

      const result = await this.geminiContractAuditService.auditContract({
        contract: {
          ...this.toContractSummary(contract),
          title: contract.tender?.title ?? null,
          procurementSubject: contract.tender?.title ?? null,
          supplierName: contract.supplierName,
          suppliers,
          customerName: contract.tender?.customerName ?? null,
          dateSigned: contract.dateSigned
            ? contract.dateSigned.toISOString().slice(0, 10)
            : null,
          currency: contract.currency,
          amount: contract.amount,
          providedDocuments,
        },
        items: extractedItems,
      });
      const reportDocument = this.buildAuditReportDocument(
        this.toContractSummary(contract),
        result.contractAnalysis,
        run.createdAt ?? new Date(),
      );
      const rawResponseWithReport = {
        ...(result.rawResponse ?? {}),
        finalContractAuditDocument: reportDocument,
      };

      const persisted = await this.prisma.contractAiAuditRun.update({
        where: { id: run.id },
        data: {
          state:
            result.items.length > 0 ? 'completed' : 'completed_no_items',
          error: null,
          model: result.model,
          itemsAudited: result.itemsAudited,
          flaggedItemsCount: result.flaggedItemsCount,
          overallRiskLevel: result.overallRiskLevel,
          overallScore: result.overallScore,
          summary: result.summary,
          items: result.items as unknown as Prisma.InputJsonValue,
          searchQueries: result.searchQueries as unknown as Prisma.InputJsonValue,
          sources: result.sources as unknown as Prisma.InputJsonValue,
          usage: result.usage
            ? (result.usage as unknown as Prisma.InputJsonValue)
            : undefined,
          rawResponse: rawResponseWithReport
            ? (rawResponseWithReport as Prisma.InputJsonValue)
            : undefined,
          finishedAt: new Date(),
        },
        include: {
          contract: {
            include: {
              tender: {
                select: {
                  tenderID: true,
                  customerName: true,
                  title: true,
                },
              },
            },
          },
        },
      });

      return this.mapPersistedAiAuditStatus(contract, persisted);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown Gemini audit error';

      await this.prisma.contractAiAuditRun.update({
        where: { id: run.id },
        data: {
          state: 'failed',
          error: message,
          finishedAt: new Date(),
        },
      });

      throw error;
    }
  }

  async getContractAiAuditStatus(
    contractRef: string,
  ): Promise<ContractAiAuditStatusResponse> {
    const contract = await this.resolveContract(contractRef);
    const latestRun = await this.getLatestAiAuditRun(contract.id);

    if (latestRun) {
      return this.mapPersistedAiAuditStatus(contract, latestRun);
    }

    return {
      contract: this.toContractSummary(contract),
      runId: null,
      state: 'idle',
      result: null,
      failureReason: null,
      timestamp: null,
      finishedOn: null,
    };
  }

  async getContractAuditReport(contractRef: string): Promise<{
    contract: {
      id: string;
      contractID: string | null;
      tenderId: string;
      tenderPublicId: string | null;
    };
    runId: string | null;
    state: string;
    reportDocument: ContractAuditReportDocument | null;
    items: ContractAiAuditResult['items'];
    failureReason: string | null;
    timestamp?: number | null;
    finishedOn?: number | null;
  }> {
    const contract = await this.resolveContract(contractRef);
    const latestRun = await this.getLatestAiAuditRun(contract.id);

    if (!latestRun) {
      return {
        contract: this.toContractSummary(contract),
        runId: null,
        state: 'idle',
        reportDocument: null,
        items: [],
        failureReason: null,
        timestamp: null,
        finishedOn: null,
      };
    }

    const mapped = this.mapPersistedAiAuditStatus(contract, latestRun);

    return {
      contract: mapped.contract,
      runId: mapped.runId,
      state: mapped.state,
      reportDocument: mapped.result?.reportDocument ?? null,
      items: Array.isArray(mapped.result?.items) ? mapped.result.items : [],
      failureReason: mapped.failureReason ?? null,
      timestamp: mapped.timestamp ?? null,
      finishedOn: mapped.finishedOn ?? null,
    };
  }

  async markRunProcessing(runId: string, jobId: string): Promise<void> {
    await this.prisma.contractExtractionRun.update({
      where: { id: runId },
      data: {
        jobId,
        state: 'processing',
        error: null,
        startedAt: new Date(),
        finishedAt: null,
      },
    });
  }

  async persistRunResult(
    runId: string,
    result: ContractExtractionResult,
  ): Promise<void> {
    await this.prisma.contractExtractionRun.update({
      where: { id: runId },
      data: {
        state: result.status,
        error: null,
        totalDocuments: result.totalDocuments,
        relevantDocuments: result.relevantDocuments,
        processedDocuments: result.processedDocuments,
        finishedAt: new Date(),
        documents: {
          create: result.documents.map((document) => ({
            title: document.title,
            url: document.url,
            mimeType: document.mimeType,
            matchedKeywords: [...document.matchedKeywords],
          extractionMethod: document.extractionMethod,
          extractedText: document.extractedText,
          candidatePages: document.candidatePages ?? [],
          usage: document.usage
            ? (document.usage as unknown as Prisma.InputJsonValue)
            : undefined,
          error: document.error ?? null,
          tables: {
              create: document.tables.map((table) => ({
                page: table.page,
                confidence: table.confidence,
                headers: table.headers,
                lines: {
                  create: table.lines.map((line) => ({
                    rowIndex: line.rowIndex,
                    cells: line.cells,
                    itemName: line.normalized?.itemName ?? null,
                    quantity: line.normalized?.quantity ?? null,
                    unit: line.normalized?.unit ?? null,
                    unitPrice: line.normalized?.unitPrice ?? null,
                    totalPrice: line.normalized?.totalPrice ?? null,
                    vat: line.normalized?.vat ?? null,
                    currency: line.normalized?.currency ?? null,
                  })),
                },
              })),
            },
          })),
        },
      },
    });
  }

  async markRunFailed(runId: string, error: string): Promise<void> {
    await this.prisma.contractExtractionRun.update({
      where: { id: runId },
      data: {
        state: 'failed',
        error,
        finishedAt: new Date(),
      },
    });
  }

  private async getLatestRun(contractId: string): Promise<any | null> {
    return this.prisma.contractExtractionRun.findFirst({
      where: {
        contractId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        contract: {
          include: {
            tender: {
              select: {
                tenderID: true,
              },
            },
          },
        },
        documents: {
          orderBy: {
            createdAt: 'asc',
          },
          include: {
            tables: {
              orderBy: {
                page: 'asc',
              },
              include: {
                lines: {
                  orderBy: {
                    rowIndex: 'asc',
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  private async getLatestAiRun(contractId: string): Promise<any | null> {
    return this.prisma.contractAiExtractionRun.findFirst({
      where: {
        contractId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        contract: {
          include: {
            tender: {
              select: {
                tenderID: true,
              },
            },
          },
        },
      },
    });
  }

  private async getLatestAiAuditRun(contractId: string): Promise<any | null> {
    return this.prisma.contractAiAuditRun.findFirst({
      where: {
        contractId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        contract: {
          include: {
            tender: {
              select: {
                tenderID: true,
                customerName: true,
              },
            },
          },
        },
      },
    });
  }

  private async getContractJob(
    contractDbId: string,
    existingJobId?: string | null,
  ): Promise<Job<ExtractionJobPayload, ContractExtractionResult> | null> {
    if (existingJobId) {
      const persistedJob = await this.extractionQueue.getJob(existingJobId);

      if (persistedJob) {
        return persistedJob;
      }
    }

    const prefixedJobs = await this.extractionQueue.getJobs([
      'active',
      'waiting',
      'delayed',
    ]);
    const matchingJob = prefixedJobs.find(
      (job) =>
        typeof job.id === 'string' &&
        job.id.startsWith(`contract-price-extraction-${contractDbId}-`),
    );

    return matchingJob ?? null;
  }

  private async mapJobStatus(
    job: Job<ExtractionJobPayload, ContractExtractionResult>,
    contract: any,
    run?: any | null,
  ): Promise<ContractExtractionStatusResponse> {
    const state = await job.getState();

    return {
      contract: this.toContractSummary(contract),
      runId: run?.id ?? null,
      jobId: String(job.id),
      state,
      result:
        state === 'completed'
          ? run
            ? this.mapStoredResult(run)
            : ((job.returnvalue as ContractExtractionResult | null) ?? null)
          : null,
      failureReason:
        state === 'failed' ? run?.error ?? job.failedReason ?? null : null,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn ?? null,
    };
  }

  private mapPersistedRunStatus(
    contract: any,
    run: any,
  ): ContractExtractionStatusResponse {
    const hasCompletedResult =
      run.state !== 'queued' &&
      run.state !== 'processing' &&
      run.state !== 'failed';

    return {
      contract: this.toContractSummary(contract),
      runId: run.id,
      jobId: run.jobId ?? null,
      state: run.state,
      result: hasCompletedResult ? this.mapStoredResult(run) : null,
      failureReason: run.state === 'failed' ? run.error ?? null : null,
      attemptsMade: undefined,
      timestamp: run.createdAt ? new Date(run.createdAt).getTime() : null,
      finishedOn: run.finishedAt ? new Date(run.finishedAt).getTime() : null,
    };
  }

  private mapPersistedAiRunStatus(
    contract: any,
    run: any,
  ): ContractAiExtractionStatusResponse {
    const hasCompletedResult =
      run.state !== 'processing' && run.state !== 'failed';

    return {
      contract: this.toContractSummary(contract),
      runId: run.id,
      state: run.state,
      result: hasCompletedResult ? this.mapStoredAiResult(run) : null,
      failureReason: run.state === 'failed' ? run.error ?? null : null,
      timestamp: run.createdAt ? new Date(run.createdAt).getTime() : null,
      finishedOn: run.finishedAt ? new Date(run.finishedAt).getTime() : null,
    };
  }

  private mapPersistedAiAuditStatus(
    contract: any,
    run: any,
  ): ContractAiAuditStatusResponse {
    const hasCompletedResult =
      run.state !== 'processing' && run.state !== 'failed';

    return {
      contract: this.toContractSummary(contract),
      runId: run.id,
      state: run.state,
      result: hasCompletedResult ? this.mapStoredAiAuditResult(run) : null,
      failureReason: run.state === 'failed' ? run.error ?? null : null,
      timestamp: run.createdAt ? new Date(run.createdAt).getTime() : null,
      finishedOn: run.finishedAt ? new Date(run.finishedAt).getTime() : null,
    };
  }

  private mapStoredResult(run: any): ContractExtractionResult {
    const documents = Array.isArray(run.documents)
      ? run.documents.map((document: any) => ({
          title: document.title,
          url: document.url,
          mimeType: document.mimeType,
          matchedKeywords: Array.isArray(document.matchedKeywords)
            ? document.matchedKeywords
            : [],
          extractionMethod: document.extractionMethod ?? null,
          extractedText:
            typeof document.extractedText === 'string'
              ? document.extractedText
              : null,
          candidatePages: Array.isArray(document.candidatePages)
            ? document.candidatePages
            : [],
          usage: parseStoredUsageMetric(document.usage),
          error: document.error ?? undefined,
          tables: Array.isArray(document.tables)
            ? document.tables.map((table: any) => ({
                page: table.page,
                headers: Array.isArray(table.headers) ? table.headers : [],
                confidence: table.confidence,
                lines: Array.isArray(table.lines)
                  ? table.lines.map((line: any) => ({
                      rowIndex: line.rowIndex,
                      cells: Array.isArray(line.cells) ? line.cells : [],
                      normalized:
                        line.itemName ||
                        line.quantity !== null ||
                        line.unit ||
                        line.unitPrice !== null ||
                        line.totalPrice !== null ||
                        line.vat ||
                        line.currency
                          ? {
                              itemName: line.itemName ?? null,
                              quantity: line.quantity ?? null,
                              unit: line.unit ?? null,
                              unitPrice: line.unitPrice ?? null,
                              totalPrice: line.totalPrice ?? null,
                              vat: line.vat ?? null,
                              currency: line.currency ?? null,
                            }
                          : null,
                    }))
                  : [],
              }))
            : [],
        }))
      : [];

    return {
      status: run.state,
      contract: {
        id: run.contract.id,
        contractID: run.contract.contractID,
        tenderId: run.contract.tenderId,
        tenderPublicId: run.contract.tender?.tenderID ?? null,
      },
      totalDocuments: run.totalDocuments ?? 0,
      relevantDocuments: run.relevantDocuments ?? 0,
      processedDocuments: run.processedDocuments ?? 0,
      documents,
      usageSummary: summarizeUsageMetrics(
        documents.map((document: { usage: unknown }) => document.usage),
      ),
    };
  }

  private mapStoredAiResult(run: any): ContractAiExtractionResult {
    const usage =
      parseStoredUsageSummary(run.usage) ??
      summarizeUsageMetrics([
        buildGeminiUsageMetric({
          stage: 'gemini-extraction',
          model: typeof run.model === 'string' ? run.model : null,
          response: run.rawResponse ?? null,
        }),
      ]);

    return {
      status: run.state,
      contract: {
        id: run.contract.id,
        contractID: run.contract.contractID,
        tenderId: run.contract.tenderId,
        tenderPublicId: run.contract.tender?.tenderID ?? null,
      },
      model: run.model,
      documentsAnalyzed: run.documentsAnalyzed ?? 0,
      sourceTextLength: run.sourceTextLength ?? 0,
      itemsExtracted: run.itemsExtracted ?? 0,
      usage,
      items: Array.isArray(run.items)
        ? run.items.map((item: any) => ({
            source:
              item?.source === 'api-fallback' ? 'api-fallback' : 'document',
            documentTitle:
              typeof item?.documentTitle === 'string' ? item.documentTitle : null,
            extractionMethod:
              item?.extractionMethod === 'pdf-text' ||
              item?.extractionMethod === 'mistral-ocr'
                ? item.extractionMethod
                : null,
            itemName: typeof item?.itemName === 'string' ? item.itemName : '',
            quantity:
              typeof item?.quantity === 'number' ? item.quantity : null,
            unit: typeof item?.unit === 'string' ? item.unit : null,
            unitPrice:
              typeof item?.unitPrice === 'number' ? item.unitPrice : null,
            totalPrice:
              typeof item?.totalPrice === 'number' ? item.totalPrice : null,
            currency:
              typeof item?.currency === 'string' ? item.currency : null,
            vat: typeof item?.vat === 'string' ? item.vat : null,
            sourceSnippet:
              typeof item?.sourceSnippet === 'string' ? item.sourceSnippet : null,
            confidence:
              typeof item?.confidence === 'number' ? item.confidence : null,
          }))
        : [],
    };
  }

  private isDocumentDerivedAiItem(item: unknown): boolean {
    return (item as any)?.source === 'document';
  }

  private countDocumentDerivedAiItems(items: unknown[]): number {
    return Array.isArray(items)
      ? items.filter((item) => this.isDocumentDerivedAiItem(item)).length
      : 0;
  }

  private mapStoredAiAuditResult(run: any): ContractAiAuditResult {
    const usage =
      parseStoredUsageSummary(run.usage) ??
      summarizeUsageMetrics([
        buildGeminiUsageMetric({
          stage: 'gemini-audit-grounded',
          model: typeof run.model === 'string' ? run.model : null,
          response:
            run?.rawResponse &&
            typeof run.rawResponse === 'object' &&
            (run.rawResponse as any).groundedResponse
              ? ((run.rawResponse as any).groundedResponse as Record<string, unknown>)
              : null,
          groundedSearchRequests: 1,
        }),
        buildGeminiUsageMetric({
          stage: 'gemini-audit-structured',
          model: typeof run.model === 'string' ? run.model : null,
          response:
            run?.rawResponse &&
            typeof run.rawResponse === 'object' &&
            (run.rawResponse as any).structuredResponse
              ? ((run.rawResponse as any).structuredResponse as Record<string, unknown>)
              : null,
        }),
        buildGeminiUsageMetric({
          stage: 'gemini-audit-final',
          model: typeof run.model === 'string' ? run.model : null,
          response:
            run?.rawResponse &&
            typeof run.rawResponse === 'object' &&
            (run.rawResponse as any).finalContractAuditResponse
              ? ((run.rawResponse as any).finalContractAuditResponse as Record<string, unknown>)
              : null,
        }),
      ]);

    const contractSummary = {
      id: run.contract.id,
      contractID: run.contract.contractID,
      tenderId: run.contract.tenderId,
      tenderPublicId: run.contract.tender?.tenderID ?? null,
    };
    const contractAnalysis = this.enrichStoredFinalContractAnalysis(
      this.mapStoredFinalContractAnalysis(
        run?.rawResponse &&
          typeof run.rawResponse === 'object' &&
          (run.rawResponse as any).finalContractAudit
          ? (run.rawResponse as any).finalContractAudit
          : null,
      ),
      run,
    );
    const reportDocument = this.mapStoredAuditReportDocument(
      run?.rawResponse &&
        typeof run.rawResponse === 'object' &&
        (run.rawResponse as any).finalContractAuditDocument
        ? (run.rawResponse as any).finalContractAuditDocument
        : null,
      contractSummary,
      contractAnalysis,
      run.finishedAt ?? run.createdAt ?? null,
    );

    return {
      status: run.state,
      contract: contractSummary,
      model: run.model,
      itemsAudited: run.itemsAudited ?? 0,
      flaggedItemsCount: run.flaggedItemsCount ?? 0,
      overallRiskLevel:
        run.overallRiskLevel === 'low' ||
        run.overallRiskLevel === 'medium' ||
        run.overallRiskLevel === 'high' ||
        run.overallRiskLevel === 'critical'
          ? run.overallRiskLevel
          : 'unknown',
      overallScore:
        typeof run.overallScore === 'number' ? run.overallScore : null,
      summary: typeof run.summary === 'string' ? run.summary : null,
      items: Array.isArray(run.items)
        ? run.items.map((item: any) => ({
            itemIndex:
              typeof item?.itemIndex === 'number' ? item.itemIndex : 0,
            itemName: typeof item?.itemName === 'string' ? item.itemName : '',
            quantity:
              typeof item?.quantity === 'number' ? item.quantity : null,
            unit: typeof item?.unit === 'string' ? item.unit : null,
            unitPrice:
              typeof item?.unitPrice === 'number' ? item.unitPrice : null,
            totalPrice:
              typeof item?.totalPrice === 'number' ? item.totalPrice : null,
            currency:
              typeof item?.currency === 'string' ? item.currency : null,
            riskLevel:
              item?.riskLevel === 'low' ||
              item?.riskLevel === 'medium' ||
              item?.riskLevel === 'high' ||
              item?.riskLevel === 'critical'
                ? item.riskLevel
                : 'unknown',
            riskScore:
              typeof item?.riskScore === 'number' ? item.riskScore : null,
            marketUnitPrice:
              typeof item?.marketUnitPrice === 'number'
                ? item.marketUnitPrice
                : null,
            marketPriceMin:
              typeof item?.marketPriceMin === 'number'
                ? item.marketPriceMin
                : null,
            marketPriceMax:
              typeof item?.marketPriceMax === 'number'
                ? item.marketPriceMax
                : null,
            overpricingPercent:
              typeof item?.overpricingPercent === 'number'
                ? item.overpricingPercent
                : null,
            findings:
              typeof item?.findings === 'string' ? item.findings : null,
            recommendation:
              typeof item?.recommendation === 'string'
                ? item.recommendation
                : null,
            confidence:
              typeof item?.confidence === 'number' ? item.confidence : null,
          }))
        : [],
      contractAnalysis,
      reportDocument,
      searchQueries: Array.isArray(run.searchQueries)
        ? run.searchQueries.filter((item: any) => typeof item === 'string')
        : [],
      sources: Array.isArray(run.sources)
        ? run.sources
            .map((source: any) => ({
              title:
                typeof source?.title === 'string' ? source.title : null,
              url: typeof source?.url === 'string' ? source.url : null,
            }))
            .filter((source: any) => source.url)
        : [],
      usage,
    };
  }

  private buildContractUsageOverview(
    extraction: ContractExtractionResult | null,
    aiExtraction: ContractAiExtractionResult | null,
    aiAudit: ContractAiAuditResult | null,
  ): ContractUsageOverview {
    const extractionUsage = extraction?.usageSummary ?? null;
    const aiExtractionUsage = aiExtraction?.usage ?? null;
    const aiAuditUsage = aiAudit?.usage ?? null;

    return {
      extraction: extractionUsage,
      aiExtraction: aiExtractionUsage,
      aiAudit: aiAuditUsage,
      total: mergeUsageSummaries([
        extractionUsage,
        aiExtractionUsage,
        aiAuditUsage,
      ]),
    };
  }

  private async resolveContract(contractRef: string) {
    const contract = await this.prisma.contract.findFirst({
      where: {
        OR: [{ id: contractRef }, { contractID: contractRef }],
      },
      include: {
        tender: {
          select: {
            id: true,
            tenderID: true,
            title: true,
            customerName: true,
          },
        },
      },
    });

    if (!contract) {
      throw new NotFoundException(`Contract not found: ${contractRef}`);
    }

    return contract;
  }

  private mapStoredFinalContractAnalysis(
    value: unknown,
  ): ContractAiAuditResult['contractAnalysis'] {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const finalContractAudit = value as Record<string, any>;

    if (
      finalContractAudit.procurementInfo &&
      typeof finalContractAudit.procurementInfo === 'object'
    ) {
      return {
        procurementInfo: {
          title: this.toNullableTrimmedString(
            finalContractAudit.procurementInfo.title,
          ),
          identifier: this.toNullableTrimmedString(
            finalContractAudit.procurementInfo.identifier,
          ),
          dateSigned: this.toNullableTrimmedString(
            finalContractAudit.procurementInfo.dateSigned,
          ),
          customer: this.toNullableTrimmedString(
            finalContractAudit.procurementInfo.customer,
          ),
          contractor: this.toNullableTrimmedString(
            finalContractAudit.procurementInfo.contractor,
          ),
          procurementSubject: this.toNullableTrimmedString(
            finalContractAudit.procurementInfo.procurementSubject,
          ),
        },
        dataAvailability: {
          providedDocuments: this.toStringArray(
            finalContractAudit.dataAvailability?.providedDocuments,
          ),
          missingCriticalDocuments: this.toStringArray(
            finalContractAudit.dataAvailability?.missingCriticalDocuments,
          ),
        },
        financialPricing: {
          totalCost: this.toNullableTrimmedString(
            finalContractAudit.financialPricing?.totalCost,
          ),
          unitPrice: this.toNullableTrimmedString(
            finalContractAudit.financialPricing?.unitPrice,
          ),
          keyPriceElements: this.toNullableTrimmedString(
            finalContractAudit.financialPricing?.keyPriceElements,
          ),
        },
        marketAnalytics: {
          estimatedMarketPrice: this.toNullableTrimmedString(
            finalContractAudit.marketAnalytics?.estimatedMarketPrice,
          ),
          comparisonMethod: this.toNullableTrimmedString(
            finalContractAudit.marketAnalytics?.comparisonMethod,
          ),
          numericComparison: this.toNullableTrimmedString(
            finalContractAudit.marketAnalytics?.numericComparison,
          ),
          itemBreakdown: this.toNullableTrimmedString(
            finalContractAudit.marketAnalytics?.itemBreakdown,
          ),
        },
        conclusion: {
          overpricingSigns:
            finalContractAudit.conclusion?.overpricingSigns === 'yes' ||
            finalContractAudit.conclusion?.overpricingSigns === 'no'
              ? finalContractAudit.conclusion.overpricingSigns
              : 'insufficient',
          estimatedDeviation: this.toNullableTrimmedString(
            finalContractAudit.conclusion?.estimatedDeviation,
          ),
          comment: this.toNullableTrimmedString(
            finalContractAudit.conclusion?.comment,
          ),
        },
      };
    }

    if (
      !finalContractAudit.financialAnalysis &&
      !finalContractAudit.marketRisk &&
      !finalContractAudit.conclusion
    ) {
      return null;
    }

    const itemsTotal =
      typeof finalContractAudit.financialAnalysis?.itemsTotal === 'number'
        ? finalContractAudit.financialAnalysis.itemsTotal
        : null;
    const contractTotal =
      typeof finalContractAudit.financialAnalysis?.contractTotal === 'number'
        ? finalContractAudit.financialAnalysis.contractTotal
        : null;
    const averageDeviationPercent =
      typeof finalContractAudit.marketRisk?.averageDeviationPercent === 'number'
        ? finalContractAudit.marketRisk.averageDeviationPercent
        : null;

    return {
      procurementInfo: {
        title: null,
        identifier: null,
        dateSigned: null,
        customer: null,
        contractor: null,
        procurementSubject: null,
      },
      dataAvailability: {
        providedDocuments: [],
        missingCriticalDocuments: [],
      },
      financialPricing: {
        totalCost:
          itemsTotal !== null || contractTotal !== null
            ? `Сума по позиціях: ${itemsTotal ?? '—'}; сума договору: ${contractTotal ?? '—'}.`
            : null,
        unitPrice: null,
        keyPriceElements: this.toLegacyConsistencyText(
          finalContractAudit.financialAnalysis?.consistency,
        ),
      },
      marketAnalytics: {
        estimatedMarketPrice: null,
        comparisonMethod: null,
        numericComparison:
          averageDeviationPercent !== null
            ? `Середній рівень відхилення: ${averageDeviationPercent.toFixed(2)}%.`
            : null,
        itemBreakdown: null,
      },
      conclusion: {
        overpricingSigns:
          finalContractAudit.conclusion?.overpricingSigns === 'yes' ||
          finalContractAudit.conclusion?.overpricingSigns === 'no'
            ? finalContractAudit.conclusion.overpricingSigns
            : 'insufficient',
        estimatedDeviation:
          averageDeviationPercent !== null
            ? `${averageDeviationPercent.toFixed(2)}%`
            : null,
        comment: this.toNullableTrimmedString(
          finalContractAudit.conclusion?.comment,
        ),
      },
    };
  }

  private enrichStoredFinalContractAnalysis(
    analysis: ContractAiAuditResult['contractAnalysis'],
    run: any,
  ): ContractAiAuditResult['contractAnalysis'] {
    if (!analysis) {
      return null;
    }

    const dateSigned =
      run?.contract?.dateSigned instanceof Date
        ? run.contract.dateSigned.toISOString().slice(0, 10)
        : typeof run?.contract?.dateSigned === 'string'
          ? run.contract.dateSigned.slice(0, 10)
          : null;

    return {
      ...analysis,
      procurementInfo: {
        ...analysis.procurementInfo,
        title:
          analysis.procurementInfo.title ??
          this.toNullableTrimmedString(run?.contract?.tender?.title),
        identifier:
          analysis.procurementInfo.identifier ??
          this.toNullableTrimmedString(run?.contract?.contractID) ??
          this.toNullableTrimmedString(run?.contract?.tender?.tenderID) ??
          this.toNullableTrimmedString(run?.contract?.id),
        dateSigned:
          analysis.procurementInfo.dateSigned ??
          this.toNullableTrimmedString(dateSigned),
        customer:
          analysis.procurementInfo.customer ??
          this.toNullableTrimmedString(run?.contract?.tender?.customerName),
        contractor:
          analysis.procurementInfo.contractor ??
          this.toNullableTrimmedString(run?.contract?.supplierName),
        procurementSubject:
          analysis.procurementInfo.procurementSubject ??
          this.toNullableTrimmedString(run?.contract?.tender?.title),
      },
      marketAnalytics: {
        ...analysis.marketAnalytics,
        itemBreakdown:
          analysis.marketAnalytics.itemBreakdown ??
          this.buildStoredAuditItemBreakdown(run?.items),
      },
    };
  }

  private buildStoredAuditItemBreakdown(items: unknown): string | null {
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const lines = items
      .map((item: any) => {
        const itemName = this.toNullableTrimmedString(item?.itemName);

        if (!itemName) {
          return null;
        }

        return [
          `${typeof item?.itemIndex === 'number' ? item.itemIndex : '—'}. ${itemName}`,
          `К-ть: ${typeof item?.quantity === 'number' ? item.quantity : '—'}`,
          `Ціна договору: ${typeof item?.unitPrice === 'number' ? item.unitPrice : '—'}`,
          `Ринкова ціна: ${typeof item?.marketUnitPrice === 'number' ? item.marketUnitPrice : '—'}`,
          `Відхилення: ${typeof item?.overpricingPercent === 'number' ? item.overpricingPercent : '—'}${typeof item?.overpricingPercent === 'number' ? '%' : ''}`,
          `Ризик: ${this.toNullableTrimmedString(item?.riskLevel) ?? '—'}`,
          this.toNullableTrimmedString(item?.currency)
            ? `Валюта: ${item.currency}`
            : null,
        ]
          .filter(Boolean)
          .join('; ');
      })
      .filter((item: string | null): item is string => Boolean(item))
      .join('\n');

    return lines.length > 0 ? lines : null;
  }

  private toNullableTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private toLegacyConsistencyText(value: unknown): string | null {
    if (value === 'yes') {
      return 'Узгодженість сум: ТАК.';
    }

    if (value === 'no') {
      return 'Узгодженість сум: НІ.';
    }

    return null;
  }

  private buildAuditReportDocument(
    contract: {
      id: string;
      contractID: string | null;
      tenderId: string;
      tenderPublicId: string | null;
    },
    analysis: ContractAiAuditResult['contractAnalysis'],
    generatedAt: Date | string | null,
  ): ContractAuditReportDocument | null {
    if (!analysis) {
      return null;
    }

    return {
      version: 1,
      generatedAt:
        generatedAt instanceof Date
          ? generatedAt.toISOString()
          : typeof generatedAt === 'string'
            ? generatedAt
            : null,
      contract,
      blocks: [
        {
          key: 'procurement-info',
          title: 'Блок 1. Загальна інформація про договір',
          items: [
            this.createReportLineItem('Назва', analysis.procurementInfo.title),
            this.createReportLineItem('ID договору', analysis.procurementInfo.identifier),
            this.createReportLineItem('Дата підписання', analysis.procurementInfo.dateSigned),
            this.createReportLineItem('Замовник', analysis.procurementInfo.customer),
            this.createReportLineItem('Постачальники', analysis.procurementInfo.contractor),
            this.createReportLineItem('Предмет закупівлі', analysis.procurementInfo.procurementSubject),
          ],
        },
        {
          key: 'data-availability',
          title: 'Блок 2. Доступність даних',
          items: [
            this.createReportListItem(
              'Надані документи',
              analysis.dataAvailability.providedDocuments,
            ),
            this.createReportListItem(
              'Відсутні критичні документи',
              analysis.dataAvailability.missingCriticalDocuments,
            ),
          ],
        },
        {
          key: 'financial-pricing',
          title: 'Блок 3. Фінансово-ціновий аналіз',
          items: [
            this.createReportTextItem('Загальна вартість', analysis.financialPricing.totalCost),
            this.createReportTextItem('Ціна за одиницю', analysis.financialPricing.unitPrice),
            this.createReportTextItem(
              'Ключові елементи ціни',
              analysis.financialPricing.keyPriceElements,
            ),
          ],
        },
        {
          key: 'market-analytics',
          title: 'Блок 4. Ринкова аналітика',
          items: [
            this.createReportTextItem(
              'Орієнтовна ринкова ціна',
              analysis.marketAnalytics.estimatedMarketPrice,
            ),
            this.createReportTextItem(
              'Метод порівняння',
              analysis.marketAnalytics.comparisonMethod,
            ),
            this.createReportTextItem(
              'Числове зіставлення',
              analysis.marketAnalytics.numericComparison,
            ),
            this.createReportTextItem(
              'Дані по позиціях договору',
              analysis.marketAnalytics.itemBreakdown,
            ),
          ],
        },
        {
          key: 'conclusion',
          title: 'Блок 5. Висновок',
          items: [
            this.createReportLineItem(
              'Ознаки завищення',
              this.toLocalizedOverpricingLabel(analysis.conclusion.overpricingSigns),
            ),
            this.createReportTextItem(
              'Орієнтовний розмір відхилення',
              analysis.conclusion.estimatedDeviation,
            ),
            this.createReportTextItem(
              'Коментар на основі фактів',
              analysis.conclusion.comment,
            ),
          ],
        },
      ],
    };
  }

  private mapStoredAuditReportDocument(
    value: unknown,
    contract: {
      id: string;
      contractID: string | null;
      tenderId: string;
      tenderPublicId: string | null;
    },
    analysis: ContractAiAuditResult['contractAnalysis'],
    generatedAt: Date | string | null,
  ): ContractAuditReportDocument | null {
    if (
      value &&
      typeof value === 'object' &&
      Array.isArray((value as any).blocks)
    ) {
      return value as ContractAuditReportDocument;
    }

    return this.buildAuditReportDocument(contract, analysis, generatedAt);
  }

  private createReportLineItem(
    label: string,
    value: string | null,
  ): ContractAuditReportDocument['blocks'][number]['items'][number] {
    return {
      type: 'line',
      label,
      value,
    };
  }

  private createReportTextItem(
    label: string,
    value: string | null,
  ): ContractAuditReportDocument['blocks'][number]['items'][number] {
    return {
      type: 'text',
      label,
      value,
    };
  }

  private createReportListItem(
    label: string,
    items: string[],
  ): ContractAuditReportDocument['blocks'][number]['items'][number] {
    return {
      type: 'list',
      label,
      value: items.length > 0 ? null : '—',
      items,
    };
  }

  private toLocalizedOverpricingLabel(
    value: 'yes' | 'no' | 'insufficient',
  ): string {
    if (value === 'yes') {
      return 'ТАК';
    }

    if (value === 'no') {
      return 'НІ';
    }

    return 'НЕДОСТАТНЬО ДАНИХ';
  }

  private formatProvidedDocumentSummary(document: any): string | null {
    const title = this.toNullableTrimmedString(document?.title);

    if (!title) {
      return null;
    }

    const normalizedTitle = title.toLowerCase();
    const mimeType = this.toNullableTrimmedString(document?.mimeType)?.toLowerCase();
    const extractedText = this.toNullableTrimmedString(document?.extractedText);

    if (
      normalizedTitle.endsWith('.p7s') ||
      mimeType === 'application/pkcs7-signature'
    ) {
      return `${title} (КЕП-підпис)`;
    }

    if (extractedText) {
      return `${title} (текст доступний)`;
    }

    if (
      normalizedTitle.endsWith('.pdf') ||
      mimeType === 'application/pdf'
    ) {
      return `${title} (є, але текст з документа не витягнуто)`;
    }

    return title;
  }

  private normalizeDocumentTitleKey(value: string): string {
    return value.replace(/\s*\(.+\)\s*$/, '').trim().toLowerCase();
  }

  private toContractSummary(contract: any) {
    return {
      id: contract.id,
      contractID: contract.contractID,
      tenderId: contract.tenderId,
      tenderPublicId: contract.tender?.tenderID ?? null,
    };
  }

  private buildJobId(contractDbId: string, runId: string): string {
    return `contract-price-extraction-${contractDbId}-${runId}`;
  }

  private async getSourceContractDetails(
    contractId: string,
    tenderId: string,
  ): Promise<{
    sourceContract: Record<string, unknown> | null;
    documents: any[];
    changes: any[];
    milestones: any[];
  }> {
    try {
      const details = await this.prozorroService.getContractDetails(
        tenderId,
        contractId,
      );

      return {
        sourceContract: details
          ? {
              id: details?.id ?? null,
              awardID: details?.awardID ?? null,
              contractID: details?.contractID ?? null,
              contractNumber: details?.contractNumber ?? null,
              description: details?.description ?? null,
              owner: details?.owner ?? null,
              status: details?.status ?? null,
              period: details?.period ?? null,
              value: details?.value ?? null,
              amountPaid: details?.amountPaid ?? null,
              buyer: details?.buyer ?? null,
              suppliers: Array.isArray(details?.suppliers) ? details.suppliers : [],
              items: Array.isArray(details?.items) ? details.items : [],
              dateSigned: details?.dateSigned ?? null,
              date: details?.date ?? null,
              dateCreated: details?.dateCreated ?? null,
              dateModified: details?.dateModified ?? null,
              rawJson: details,
            }
          : null,
        documents: Array.isArray(details?.documents)
          ? details.documents.map((document: any) => ({
              id: document?.id ?? null,
              title: document?.title ?? 'Без назви',
              url: document?.url ?? null,
              format: document?.format ?? null,
              documentType: document?.documentType ?? null,
              datePublished: document?.datePublished ?? null,
              dateModified: document?.dateModified ?? null,
            }))
          : [],
        changes: Array.isArray(details?.changes)
          ? details.changes.map((change: any) => ({
              id: change?.id ?? null,
              rationale: change?.rationale ?? null,
              dateSigned: change?.dateSigned ?? null,
              date: change?.date ?? null,
            }))
          : [],
        milestones: Array.isArray(details?.milestones)
          ? details.milestones.map((milestone: any) => ({
              id: milestone?.id ?? null,
              title: milestone?.title ?? null,
              description: milestone?.description ?? null,
              type: milestone?.type ?? null,
              code: milestone?.code ?? null,
              percentage: milestone?.percentage ?? null,
              duration: milestone?.duration ?? null,
              status: milestone?.status ?? null,
            }))
          : [],
      };
    } catch {
      return {
        sourceContract: null,
        documents: [],
        changes: [],
        milestones: [],
      };
    }
  }
}
