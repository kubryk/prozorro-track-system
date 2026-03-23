import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import {
  AiAuditedContractItem,
  AiExtractedContractItem,
  ContractAiAuditResult,
  ContractFinalAuditAnalysis,
  ContractAuditRiskLevel,
  ContractAuditSource,
} from './contract-extraction.types';
import { ContractPromptSettingsService } from './contract-prompt-settings.service';
import {
  buildGeminiUsageMetric,
  summarizeUsageMetrics,
} from './contract-usage.utils';

interface AuditContractSummary {
  id: string;
  contractID: string | null;
  tenderId: string;
  tenderPublicId: string | null;
  title?: string | null;
  procurementSubject?: string | null;
  supplierName?: string | null;
  customerName?: string | null;
  suppliers?: string[];
  dateSigned?: string | null;
  currency?: string | null;
  amount?: number | null;
  providedDocuments?: string[];
}

@Injectable()
export class GeminiContractAuditService {
  constructor(
    private readonly httpService: HttpService,
    private readonly contractPromptSettingsService: ContractPromptSettingsService,
  ) {}

  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  getModel(): string {
    return process.env.GEMINI_CONTRACT_AUDIT_MODEL || 'gemini-2.5-flash-lite';
  }

  async auditContract(args: {
    contract: AuditContractSummary;
    items: AiExtractedContractItem[];
  }): Promise<{
    model: string;
    itemsAudited: number;
    flaggedItemsCount: number;
    overallRiskLevel: ContractAuditRiskLevel;
    overallScore: number | null;
    summary: string | null;
    items: AiAuditedContractItem[];
    contractAnalysis: ContractFinalAuditAnalysis | null;
    searchQueries: string[];
    sources: ContractAuditSource[];
    rawResponse: Record<string, unknown> | null;
    usage: ReturnType<typeof summarizeUsageMetrics>;
  }> {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error(
        'Gemini is not configured. Set GEMINI_API_KEY to enable contract audit.',
      );
    }

    const items = args.items
      .map((item, index) => ({
        itemIndex: index + 1,
        itemName: item.itemName.trim(),
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        currency: item.currency,
      }))
      .filter((item) => item.itemName.length > 0);

    const maxItems = Number.parseInt(
      process.env.GEMINI_CONTRACT_AUDIT_MAX_ITEMS || '',
      10,
    );
    const limitedItems =
      Number.isFinite(maxItems) && maxItems > 0
        ? items.slice(0, maxItems)
        : items.slice(0, 20);

    const model = this.getModel();
    const groundedPayload = await this.generateGroundedAuditPayload(
      apiKey,
      model,
      args.contract,
      limitedItems,
    );
    const groundedResponse = groundedPayload.response;
    const groundedText = groundedPayload.text;
    const groundedUsage = buildGeminiUsageMetric({
      stage: 'gemini-audit-grounded',
      model,
      response: groundedResponse,
      groundedSearchRequests: 1,
    });
    const normalized = await this.normalizeGroundedAudit(
      apiKey,
      model,
      args.contract,
      limitedItems,
      groundedText,
    );
    const finalAudit = await this.generateFinalContractAudit(
      apiKey,
      model,
      args.contract,
      normalized.parsed.items,
    );
    const contractAnalysis = this.enrichFinalContractAnalysis(
      finalAudit.analysis,
      args.contract,
      normalized.parsed.items,
    );
    const searchMetadata = this.extractGroundingMetadata(groundedResponse);
    const usage = summarizeUsageMetrics([
      groundedUsage,
      normalized.usage,
      finalAudit.usage,
    ]);

    return {
      model,
      itemsAudited: limitedItems.length,
      flaggedItemsCount: normalized.parsed.flaggedItemsCount,
      overallRiskLevel: normalized.parsed.overallRiskLevel,
      overallScore: normalized.parsed.overallScore,
      summary: normalized.parsed.summary,
      items: normalized.parsed.items,
      contractAnalysis,
      searchQueries: searchMetadata.searchQueries,
      sources: searchMetadata.sources,
      usage,
      rawResponse: {
        groundedResponse,
        structuredResponse: normalized.structuredResponse,
        finalContractAuditResponse: finalAudit.response,
        finalContractAudit: contractAnalysis,
      },
    };
  }

  private async generateGroundedAuditPayload(
    apiKey: string,
    model: string,
    contract: AuditContractSummary,
    items: Array<{
      itemIndex: number;
      itemName: string;
      quantity: number | null;
      unit: string | null;
      unitPrice: number | null;
      totalPrice: number | null;
      currency: string | null;
    }>,
  ): Promise<{
    response: Record<string, unknown> | null;
    text: string;
  }> {
    let lastResponse: Record<string, unknown> | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.generateGroundedAuditResponse(
        apiKey,
        model,
        contract,
        items,
      );
      const text = this.tryExtractResponseText(response);

      lastResponse = response;

      if (text) {
        return {
          response,
          text,
        };
      }
    }

    throw new Error(
      this.buildEmptyAuditPayloadMessage(lastResponse),
    );
  }

  private async generateGroundedAuditResponse(
    apiKey: string,
    model: string,
    contract: AuditContractSummary,
    items: Array<{
      itemIndex: number;
      itemName: string;
      quantity: number | null;
      unit: string | null;
      unitPrice: number | null;
      totalPrice: number | null;
      currency: string | null;
    }>,
  ): Promise<Record<string, unknown> | null> {
    const prompts = await this.contractPromptSettingsService.getTemplateValues([
      'gemini_contract_audit_grounded_system',
      'gemini_contract_audit_grounded_user',
    ]);
    const body = {
      systemInstruction: {
        parts: [
          {
            text: prompts.gemini_contract_audit_grounded_system,
          },
        ],
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: this.buildUserPrompt(
                contract,
                items,
                prompts.gemini_contract_audit_grounded_user,
              ),
            },
          ],
        },
      ],
      tools: [
        {
          google_search: {},
        },
      ],
      generationConfig: {
        temperature: 0.1,
      },
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          body,
          {
            headers: {
              'Content-Type': 'application/json',
            },
            timeout: 120000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          },
        ),
      );

      return response.data ?? null;
    } catch (error) {
      throw new Error(this.buildGeminiErrorMessage(error, model));
    }
  }

  private async normalizeGroundedAudit(
    apiKey: string,
    model: string,
    contract: AuditContractSummary,
    items: Array<{
      itemIndex: number;
      itemName: string;
      quantity: number | null;
      unit: string | null;
      unitPrice: number | null;
      totalPrice: number | null;
      currency: string | null;
    }>,
    groundedText: string,
  ): Promise<{
    parsed: {
      overallRiskLevel: ContractAuditRiskLevel;
      overallScore: number | null;
      flaggedItemsCount: number;
      summary: string | null;
      items: AiAuditedContractItem[];
    };
    structuredResponse: Record<string, unknown> | null;
    usage: ReturnType<typeof buildGeminiUsageMetric>;
  }> {
    try {
      return {
        parsed: this.parseAudit(groundedText),
        structuredResponse: null,
        usage: null,
      };
    } catch {
      const structuredResponse = await this.generateStructuredAuditResponse(
        apiKey,
        model,
        contract,
        items,
        groundedText,
      );
      const structuredText = this.extractResponseText(structuredResponse);

      return {
        parsed: this.parseAudit(structuredText),
        structuredResponse,
        usage: buildGeminiUsageMetric({
          stage: 'gemini-audit-structured',
          model,
          response: structuredResponse,
        }),
      };
    }
  }

  private async generateStructuredAuditResponse(
    apiKey: string,
    model: string,
    contract: AuditContractSummary,
    items: Array<{
      itemIndex: number;
      itemName: string;
      quantity: number | null;
      unit: string | null;
      unitPrice: number | null;
      totalPrice: number | null;
      currency: string | null;
    }>,
    groundedText: string,
  ): Promise<Record<string, unknown> | null> {
    const prompts = await this.contractPromptSettingsService.getTemplateValues([
      'gemini_contract_audit_structured_system',
      'gemini_contract_audit_structured_user',
    ]);
    const originalItemsText = items
      .map((item) =>
        [
          `itemIndex: ${item.itemIndex}`,
          `itemName: ${item.itemName}`,
          `quantity: ${item.quantity ?? 'unknown'}`,
          `unit: ${item.unit ?? 'unknown'}`,
          `unitPrice: ${item.unitPrice ?? 'unknown'}`,
          `totalPrice: ${item.totalPrice ?? 'unknown'}`,
          `currency: ${item.currency ?? contract.currency ?? 'unknown'}`,
        ].join('\n'),
      )
      .join('\n\n');
    const body = {
      systemInstruction: {
        parts: [
          {
            text: prompts.gemini_contract_audit_structured_system,
          },
        ],
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: this.contractPromptSettingsService.renderTemplate(
                prompts.gemini_contract_audit_structured_user,
                {
                  contract_id: contract.contractID || 'unknown',
                  tender_id: contract.tenderPublicId || 'unknown',
                  original_items_text: originalItemsText,
                  grounded_text: groundedText,
                },
              ),
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseJsonSchema: this.getResponseJsonSchema(),
      },
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          body,
          {
            headers: {
              'Content-Type': 'application/json',
            },
            timeout: 120000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          },
        ),
      );

      return response.data ?? null;
    } catch (error) {
      throw new Error(this.buildGeminiErrorMessage(error, model));
    }
  }

  private async generateFinalContractAudit(
    apiKey: string,
    model: string,
    contract: AuditContractSummary,
    items: AiAuditedContractItem[],
  ): Promise<{
    analysis: ContractFinalAuditAnalysis | null;
    response: Record<string, unknown> | null;
    usage: ReturnType<typeof buildGeminiUsageMetric>;
  }> {
    if (!items.length) {
      return {
        analysis: null,
        response: null,
        usage: null,
      };
    }

    const prompts = await this.contractPromptSettingsService.getTemplateValues([
      'gemini_contract_audit_final_system',
      'gemini_contract_audit_final_user',
    ]);
    const body = {
      systemInstruction: {
        parts: [
          {
            text: prompts.gemini_contract_audit_final_system,
          },
        ],
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: this.buildFinalContractAuditPrompt(
                contract,
                items,
                prompts.gemini_contract_audit_final_user,
              ),
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseJsonSchema: this.getFinalContractAuditJsonSchema(),
      },
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          body,
          {
            headers: {
              'Content-Type': 'application/json',
            },
            timeout: 120000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          },
        ),
      );
      const responseData = response.data ?? null;
      const text = this.extractResponseText(responseData);

      return {
        analysis: this.parseFinalContractAudit(text),
        response: responseData,
        usage: buildGeminiUsageMetric({
          stage: 'gemini-audit-final',
          model,
          response: responseData,
        }),
      };
    } catch (error) {
      throw new Error(this.buildGeminiErrorMessage(error, model));
    }
  }

  private buildUserPrompt(
    contract: AuditContractSummary,
    items: Array<{
      itemIndex: number;
      itemName: string;
      quantity: number | null;
      unit: string | null;
      unitPrice: number | null;
      totalPrice: number | null;
      currency: string | null;
    }>,
    template: string,
  ): string {
    const itemsText = items
      .map((item) =>
        [
          `## ITEM ${item.itemIndex}`,
          `itemIndex: ${item.itemIndex}`,
          `itemName: ${item.itemName}`,
          `quantity: ${item.quantity ?? 'unknown'}`,
          `unit: ${item.unit ?? 'unknown'}`,
          `unitPrice: ${item.unitPrice ?? 'unknown'}`,
          `totalPrice: ${item.totalPrice ?? 'unknown'}`,
          `currency: ${item.currency ?? contract.currency ?? 'unknown'}`,
        ].join('\n'),
      )
      .join('\n\n');

    return this.contractPromptSettingsService.renderTemplate(template, {
      contract_id: contract.contractID || 'unknown',
      tender_id: contract.tenderPublicId || 'unknown',
      date_signed: contract.dateSigned || 'unknown',
      customer_name: contract.customerName || 'unknown',
      supplier_name: contract.supplierName || 'unknown',
      items_text: itemsText,
    });
  }

  private buildFinalContractAuditPrompt(
    contract: AuditContractSummary,
    items: AiAuditedContractItem[],
    template: string,
  ): string {
    const auditedItemsText = items
      .map((item) =>
        [
          `Позиція ${item.itemIndex}`,
          `Назва: ${item.itemName}`,
          `Кількість: ${item.quantity ?? 'невідомо'}`,
          `Одиниця: ${item.unit ?? 'невідомо'}`,
          `Ціна за одиницю договору: ${item.unitPrice ?? 'невідомо'}`,
          `Сума позиції: ${item.totalPrice ?? 'невідомо'}`,
          `Валюта: ${item.currency ?? contract.currency ?? 'невідомо'}`,
          `Ринкова ціна: ${item.marketUnitPrice ?? 'невідомо'}`,
          `Ринковий мінімум: ${item.marketPriceMin ?? 'невідомо'}`,
          `Ринковий максимум: ${item.marketPriceMax ?? 'невідомо'}`,
          `Відхилення, %: ${item.overpricingPercent ?? 'невідомо'}`,
          `Ризик: ${item.riskLevel}`,
        ].join('\n'),
      )
      .join('\n\n');

    return this.contractPromptSettingsService.renderTemplate(template, {
      contract_id: contract.contractID || 'невідомо',
      tender_id: contract.tenderPublicId || 'невідомо',
      date_signed: contract.dateSigned || 'невідомо',
      contract_title: contract.title || 'невідомо',
      procurement_subject: contract.procurementSubject || contract.title || 'невідомо',
      customer_name: contract.customerName || 'невідомо',
      supplier_name:
        (Array.isArray(contract.suppliers) && contract.suppliers.length > 0
          ? contract.suppliers.join(', ')
          : contract.supplierName) || 'невідомо',
      contract_amount: contract.amount ?? 'невідомо',
      contract_currency: contract.currency || 'невідомо',
      provided_documents_text:
        Array.isArray(contract.providedDocuments) && contract.providedDocuments.length > 0
          ? contract.providedDocuments.map((title, index) => `${index + 1}. ${title}`).join('\n')
          : 'Документи не надані або перелік недоступний.',
      audited_items_text: auditedItemsText,
    });
  }

  private getResponseJsonSchema() {
    return {
      type: 'object',
      properties: {
        overallRiskLevel: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical', 'unknown'],
        },
        overallScore: { type: 'number' },
        flaggedItemsCount: { type: 'number' },
        summary: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              itemIndex: { type: 'number' },
              itemName: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string' },
              unitPrice: { type: 'number' },
              totalPrice: { type: 'number' },
              currency: { type: 'string' },
              riskLevel: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical', 'unknown'],
              },
              riskScore: { type: 'number' },
              marketUnitPrice: { type: 'number' },
              marketPriceMin: { type: 'number' },
              marketPriceMax: { type: 'number' },
              overpricingPercent: { type: 'number' },
              findings: { type: 'string' },
              recommendation: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['itemIndex', 'itemName', 'riskLevel'],
          },
        },
      },
      required: ['overallRiskLevel', 'flaggedItemsCount', 'items'],
    };
  }

  private getFinalContractAuditJsonSchema() {
    return {
      type: 'object',
      properties: {
        procurementInfo: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            identifier: { type: 'string' },
            dateSigned: { type: 'string' },
            customer: { type: 'string' },
            contractor: { type: 'string' },
            procurementSubject: { type: 'string' },
          },
          required: ['title', 'identifier', 'dateSigned', 'customer', 'contractor', 'procurementSubject'],
        },
        dataAvailability: {
          type: 'object',
          properties: {
            providedDocuments: {
              type: 'array',
              items: { type: 'string' },
            },
            missingCriticalDocuments: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['providedDocuments', 'missingCriticalDocuments'],
        },
        financialPricing: {
          type: 'object',
          properties: {
            totalCost: { type: 'string' },
            unitPrice: { type: 'string' },
            keyPriceElements: { type: 'string' },
          },
          required: ['totalCost', 'unitPrice', 'keyPriceElements'],
        },
        marketAnalytics: {
          type: 'object',
          properties: {
            estimatedMarketPrice: { type: 'string' },
            comparisonMethod: { type: 'string' },
            numericComparison: { type: 'string' },
            itemBreakdown: { type: 'string' },
          },
          required: ['estimatedMarketPrice', 'comparisonMethod', 'numericComparison', 'itemBreakdown'],
        },
        conclusion: {
          type: 'object',
          properties: {
            overpricingSigns: {
              type: 'string',
              enum: ['yes', 'no', 'insufficient'],
            },
            estimatedDeviation: { type: 'string' },
            comment: { type: 'string' },
          },
          required: ['overpricingSigns', 'estimatedDeviation', 'comment'],
        },
      },
      required: [
        'procurementInfo',
        'dataAvailability',
        'financialPricing',
        'marketAnalytics',
        'conclusion',
      ],
    };
  }

  private extractResponseText(response: Record<string, unknown> | null): string {
    const text = this.tryExtractResponseText(response);

    if (!text) {
      throw new Error(this.buildEmptyAuditPayloadMessage(response));
    }

    return text;
  }

  private tryExtractResponseText(
    response: Record<string, unknown> | null,
  ): string | null {
    const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
    const parts = candidates.flatMap((candidate: any) =>
      Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [],
    );
    const text = parts
      .map((part: any) => (typeof part?.text === 'string' ? part.text.trim() : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();

    return text || null;
  }

  private parseAudit(text: string): {
    overallRiskLevel: ContractAuditRiskLevel;
    overallScore: number | null;
    flaggedItemsCount: number;
    summary: string | null;
    items: AiAuditedContractItem[];
  } {
    let parsed: any;

    try {
      parsed = JSON.parse(this.extractJsonCandidate(text));
    } catch {
      throw new Error('Gemini returned invalid JSON for contract audit.');
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const normalizedItems = items
      .map((item: any) => {
        const contractUnitPrice = this.toNumberOrNull(item?.unitPrice);
        const marketPriceMin = this.toNumberOrNull(item?.marketPriceMin);
        const marketPriceMax = this.toNumberOrNull(item?.marketPriceMax);
        const marketUnitPrice = this.resolveMarketUnitPrice(
          this.toNumberOrNull(item?.marketUnitPrice),
          marketPriceMin,
          marketPriceMax,
        );

        return {
          itemIndex:
            typeof item?.itemIndex === 'number' && Number.isFinite(item.itemIndex)
              ? item.itemIndex
              : 0,
          itemName:
            typeof item?.itemName === 'string' ? item.itemName.trim() : '',
          quantity: this.toNumberOrNull(item?.quantity),
          unit: typeof item?.unit === 'string' ? item.unit : null,
          unitPrice: contractUnitPrice,
          totalPrice: this.toNumberOrNull(item?.totalPrice),
          currency: typeof item?.currency === 'string' ? item.currency : null,
          riskLevel: this.toRiskLevel(item?.riskLevel),
          riskScore: this.toNumberOrNull(item?.riskScore),
          marketUnitPrice,
          marketPriceMin,
          marketPriceMax,
          overpricingPercent: this.resolveOverpricingPercent(
            this.toNumberOrNull(item?.overpricingPercent),
            contractUnitPrice,
            marketUnitPrice,
          ),
          findings: typeof item?.findings === 'string' ? item.findings : null,
          recommendation:
            typeof item?.recommendation === 'string' ? item.recommendation : null,
          confidence: this.toNumberOrNull(item?.confidence),
        };
      })
      .filter((item: AiAuditedContractItem) => item.itemIndex > 0 && item.itemName);

    return {
      overallRiskLevel: this.toRiskLevel(parsed?.overallRiskLevel),
      overallScore: this.toNumberOrNull(parsed?.overallScore),
      flaggedItemsCount:
        typeof parsed?.flaggedItemsCount === 'number' &&
        Number.isFinite(parsed.flaggedItemsCount)
          ? parsed.flaggedItemsCount
          : normalizedItems.filter((item: AiAuditedContractItem) =>
              ['medium', 'high', 'critical'].includes(item.riskLevel),
            ).length,
      summary: typeof parsed?.summary === 'string' ? parsed.summary : null,
      items: normalizedItems,
    };
  }

  private parseFinalContractAudit(text: string): ContractFinalAuditAnalysis {
    let parsed: any;

    try {
      parsed = JSON.parse(this.extractJsonCandidate(text));
    } catch {
      throw new Error('Gemini returned invalid JSON for final contract audit.');
    }

    return {
      procurementInfo: {
        title:
          typeof parsed?.procurementInfo?.title === 'string'
            ? parsed.procurementInfo.title.trim()
            : null,
        identifier:
          typeof parsed?.procurementInfo?.identifier === 'string'
            ? parsed.procurementInfo.identifier.trim()
            : null,
        dateSigned:
          typeof parsed?.procurementInfo?.dateSigned === 'string'
            ? parsed.procurementInfo.dateSigned.trim()
            : null,
        customer:
          typeof parsed?.procurementInfo?.customer === 'string'
            ? parsed.procurementInfo.customer.trim()
            : null,
        contractor:
          typeof parsed?.procurementInfo?.contractor === 'string'
            ? parsed.procurementInfo.contractor.trim()
            : null,
        procurementSubject:
          typeof parsed?.procurementInfo?.procurementSubject === 'string'
            ? parsed.procurementInfo.procurementSubject.trim()
            : null,
      },
      dataAvailability: {
        providedDocuments: Array.isArray(parsed?.dataAvailability?.providedDocuments)
          ? parsed.dataAvailability.providedDocuments
              .filter((item: unknown): item is string => typeof item === 'string')
              .map((item: string) => item.trim())
              .filter(Boolean)
          : [],
        missingCriticalDocuments: Array.isArray(parsed?.dataAvailability?.missingCriticalDocuments)
          ? parsed.dataAvailability.missingCriticalDocuments
              .filter((item: unknown): item is string => typeof item === 'string')
              .map((item: string) => item.trim())
              .filter(Boolean)
          : [],
      },
      financialPricing: {
        totalCost:
          typeof parsed?.financialPricing?.totalCost === 'string'
            ? parsed.financialPricing.totalCost.trim()
            : null,
        unitPrice:
          typeof parsed?.financialPricing?.unitPrice === 'string'
            ? parsed.financialPricing.unitPrice.trim()
            : null,
        keyPriceElements:
          typeof parsed?.financialPricing?.keyPriceElements === 'string'
            ? parsed.financialPricing.keyPriceElements.trim()
            : null,
      },
      marketAnalytics: {
        estimatedMarketPrice:
          typeof parsed?.marketAnalytics?.estimatedMarketPrice === 'string'
            ? parsed.marketAnalytics.estimatedMarketPrice.trim()
            : null,
        comparisonMethod:
          typeof parsed?.marketAnalytics?.comparisonMethod === 'string'
            ? parsed.marketAnalytics.comparisonMethod.trim()
            : null,
        numericComparison:
          typeof parsed?.marketAnalytics?.numericComparison === 'string'
            ? parsed.marketAnalytics.numericComparison.trim()
            : null,
        itemBreakdown:
          typeof parsed?.marketAnalytics?.itemBreakdown === 'string'
            ? parsed.marketAnalytics.itemBreakdown.trim()
            : null,
      },
      conclusion: {
        overpricingSigns:
          parsed?.conclusion?.overpricingSigns === 'yes' ||
          parsed?.conclusion?.overpricingSigns === 'no'
            ? parsed.conclusion.overpricingSigns
            : 'insufficient',
        estimatedDeviation:
          typeof parsed?.conclusion?.estimatedDeviation === 'string'
            ? parsed.conclusion.estimatedDeviation.trim()
            : null,
        comment:
          typeof parsed?.conclusion?.comment === 'string'
            ? parsed.conclusion.comment.trim()
            : null,
      },
    };
  }

  private enrichFinalContractAnalysis(
    analysis: ContractFinalAuditAnalysis | null,
    contract: AuditContractSummary,
    items: AiAuditedContractItem[],
  ): ContractFinalAuditAnalysis | null {
    const baseAnalysis =
      analysis ??
      ({
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
          totalCost: null,
          unitPrice: null,
          keyPriceElements: null,
        },
        marketAnalytics: {
          estimatedMarketPrice: null,
          comparisonMethod: null,
          numericComparison: null,
          itemBreakdown: null,
        },
        conclusion: {
          overpricingSigns: 'insufficient',
          estimatedDeviation: null,
          comment: null,
        },
      } satisfies ContractFinalAuditAnalysis);

    const derivedTitle = this.toTrimmedString(contract.title);
    const derivedIdentifier =
      this.toTrimmedString(contract.contractID) ??
      this.toTrimmedString(contract.tenderPublicId) ??
      this.toTrimmedString(contract.id);
    const derivedDateSigned = this.toTrimmedString(contract.dateSigned);
    const derivedCustomer = this.toTrimmedString(contract.customerName);
    const derivedSuppliers = Array.isArray(contract.suppliers)
      ? contract.suppliers
          .map((item) => this.toTrimmedString(item))
          .filter((item): item is string => Boolean(item))
      : [];
    const derivedContractor =
      derivedSuppliers.length > 0
        ? derivedSuppliers.join(', ')
        : this.toTrimmedString(contract.supplierName);
    const derivedProcurementSubject =
      this.toTrimmedString(contract.procurementSubject) ?? derivedTitle;
    const providedDocuments = Array.isArray(contract.providedDocuments)
      ? contract.providedDocuments
          .map((item) => this.toTrimmedString(item))
          .filter((item): item is string => Boolean(item))
      : [];
    const derivedTotalCost = this.formatContractAmount(
      contract.amount,
      contract.currency,
    );
    const derivedUnitPrice = this.buildDerivedUnitPriceSummary(items);

    return {
      procurementInfo: {
        title: derivedTitle ?? baseAnalysis.procurementInfo.title,
        identifier: derivedIdentifier ?? baseAnalysis.procurementInfo.identifier,
        dateSigned: derivedDateSigned ?? baseAnalysis.procurementInfo.dateSigned,
        customer: derivedCustomer ?? baseAnalysis.procurementInfo.customer,
        contractor: derivedContractor ?? baseAnalysis.procurementInfo.contractor,
        procurementSubject:
          derivedProcurementSubject ??
          baseAnalysis.procurementInfo.procurementSubject,
      },
      dataAvailability: {
        providedDocuments:
          providedDocuments.length > 0
            ? providedDocuments
            : baseAnalysis.dataAvailability.providedDocuments,
        missingCriticalDocuments:
          baseAnalysis.dataAvailability.missingCriticalDocuments,
      },
      financialPricing: {
        totalCost: derivedTotalCost ?? baseAnalysis.financialPricing.totalCost,
        unitPrice:
          derivedUnitPrice ?? baseAnalysis.financialPricing.unitPrice,
        keyPriceElements: baseAnalysis.financialPricing.keyPriceElements,
      },
      marketAnalytics: {
        ...baseAnalysis.marketAnalytics,
        itemBreakdown:
          baseAnalysis.marketAnalytics.itemBreakdown ??
          this.buildDerivedMarketItemBreakdown(items),
      },
      conclusion: baseAnalysis.conclusion,
    };
  }

  private buildDerivedMarketItemBreakdown(
    items: AiAuditedContractItem[],
  ): string | null {
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const lines = items
      .map((item) => {
        const parts = [
          `${item.itemIndex}. ${item.itemName}`,
          `К-ть: ${item.quantity ?? '—'}`,
          `Ціна договору: ${item.unitPrice ?? '—'}`,
          `Ринкова ціна: ${item.marketUnitPrice ?? '—'}`,
          `Відхилення: ${item.overpricingPercent ?? '—'}%`,
          `Ризик: ${item.riskLevel}`,
        ];

        if (item.currency) {
          parts.push(`Валюта: ${item.currency}`);
        }

        return parts.join('; ');
      })
      .join('\n');

    return lines.length > 0 ? lines : null;
  }

  private buildDerivedUnitPriceSummary(
    items: AiAuditedContractItem[],
  ): string | null {
    const unitPrices = items
      .map((item) => ({
        value:
          typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice)
            ? item.unitPrice
            : null,
        currency: this.toTrimmedString(item.currency),
      }))
      .filter(
        (
          item,
        ): item is {
          value: number;
          currency: string | null;
        } => item.value !== null,
      );

    if (unitPrices.length === 0) {
      return null;
    }

    const values = unitPrices.map((item) => item.value);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const currencies = [...new Set(unitPrices.map((item) => item.currency).filter(Boolean))];
    const currencyLabel = currencies.length === 1 ? ` ${currencies[0]}` : '';

    if (minValue === maxValue) {
      return `${this.formatNumber(minValue)}${currencyLabel}`;
    }

    return `від ${this.formatNumber(minValue)} до ${this.formatNumber(maxValue)}${currencyLabel}`;
  }

  private formatContractAmount(
    amount: number | null | undefined,
    currency: string | null | undefined,
  ): string | null {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      return null;
    }

    const currencyLabel = this.toTrimmedString(currency);
    return currencyLabel
      ? `${this.formatNumber(amount)} ${currencyLabel}`
      : this.formatNumber(amount);
  }

  private formatNumber(value: number): string {
    return value.toLocaleString('uk-UA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  private toTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private extractGroundingMetadata(response: Record<string, unknown> | null): {
    searchQueries: string[];
    sources: ContractAuditSource[];
  } {
    const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
    const groundingMetadata = (candidates[0] as any)?.groundingMetadata;
    const searchQueries = Array.isArray(groundingMetadata?.webSearchQueries)
      ? groundingMetadata.webSearchQueries.filter(
          (query: unknown): query is string =>
            typeof query === 'string' && query.trim().length > 0,
        )
      : [];
    const chunks = Array.isArray(groundingMetadata?.groundingChunks)
      ? groundingMetadata.groundingChunks
      : [];
    const seen = new Set<string>();
    const sources = chunks
      .map((chunk: any) => ({
        title:
          typeof chunk?.web?.title === 'string' ? chunk.web.title : null,
        url: typeof chunk?.web?.uri === 'string' ? chunk.web.uri : null,
      }))
      .filter((source: ContractAuditSource) => source.url)
      .filter((source: ContractAuditSource) => {
        const key = `${source.title || ''}|${source.url || ''}`;
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });

    return {
      searchQueries,
      sources,
    };
  }

  private toNumberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    return null;
  }

  private toRiskLevel(value: unknown): ContractAuditRiskLevel {
    return value === 'low' ||
      value === 'medium' ||
      value === 'high' ||
      value === 'critical'
      ? value
      : 'unknown';
  }

  private resolveMarketUnitPrice(
    explicitValue: number | null,
    minValue: number | null,
    maxValue: number | null,
  ): number | null {
    if (typeof explicitValue === 'number' && explicitValue > 0) {
      return explicitValue;
    }

    if (
      typeof minValue === 'number' &&
      minValue > 0 &&
      typeof maxValue === 'number' &&
      maxValue > 0
    ) {
      return this.roundTo((minValue + maxValue) / 2, 2);
    }

    if (typeof minValue === 'number' && minValue > 0) {
      return minValue;
    }

    if (typeof maxValue === 'number' && maxValue > 0) {
      return maxValue;
    }

    return null;
  }

  private resolveOverpricingPercent(
    explicitValue: number | null,
    contractUnitPrice: number | null,
    marketUnitPrice: number | null,
  ): number | null {
    if (typeof explicitValue === 'number' && Number.isFinite(explicitValue)) {
      return explicitValue;
    }

    if (
      typeof contractUnitPrice === 'number' &&
      contractUnitPrice > 0 &&
      typeof marketUnitPrice === 'number' &&
      marketUnitPrice > 0
    ) {
      return this.roundTo(
        ((contractUnitPrice - marketUnitPrice) / marketUnitPrice) * 100,
        2,
      );
    }

    return null;
  }

  private roundTo(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  private buildGeminiErrorMessage(error: unknown, model: string): string {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const apiMessage =
        typeof error.response?.data?.error?.message === 'string'
          ? error.response.data.error.message
          : typeof error.response?.data?.message === 'string'
            ? error.response.data.message
            : error.message;

      return [`Gemini contract audit failed for model ${model}`, status ? `(HTTP ${status})` : '', `: ${apiMessage}`].join('');
    }

    return error instanceof Error ? error.message : 'Unknown Gemini contract audit error';
  }

  private buildEmptyAuditPayloadMessage(
    response: Record<string, unknown> | null,
  ): string {
    const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
    const firstCandidate = candidates[0] as any;
    const finishReason =
      typeof firstCandidate?.finishReason === 'string'
        ? firstCandidate.finishReason
        : null;
    const blockReason =
      typeof (response as any)?.promptFeedback?.blockReason === 'string'
        ? (response as any).promptFeedback.blockReason
        : null;
    const messageParts = ['Gemini returned no textual audit payload'];

    if (finishReason) {
      messageParts.push(`finishReason=${finishReason}`);
    }

    if (blockReason) {
      messageParts.push(`blockReason=${blockReason}`);
    }

    return messageParts.join(' | ');
  }

  private extractJsonCandidate(text: string): string {
    const trimmed = text.trim();

    if (!trimmed) {
      return trimmed;
    }

    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim();
    }

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1).trim();
    }

    return trimmed;
  }
}
