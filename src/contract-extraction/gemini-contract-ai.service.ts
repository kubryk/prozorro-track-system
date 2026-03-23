import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { AiExtractedContractItem } from './contract-extraction.types';
import { dedupeAiExtractedItems } from './ai-extracted-items.utils';
import { alignAiExtractedItemsToApiItems } from './ai-extracted-items-alignment.utils';
import { extractTextAfterSpecification } from './contract-extraction.utils';
import { ContractPromptSettingsService } from './contract-prompt-settings.service';
import {
  buildGeminiUsageMetric,
  summarizeUsageMetrics,
} from './contract-usage.utils';

interface GeminiSourceDocument {
  title: string;
  extractionMethod: 'pdf-text' | 'mistral-ocr' | null;
  extractedText: string;
}

interface GeminiApiContractItem {
  description?: string | null;
  quantity?: number | null;
  unit?: {
    name?: string | null;
    code?: string | null;
    value?: {
      amount?: number | null;
      currency?: string | null;
    } | null;
  } | null;
  classification?: {
    description?: string | null;
  } | null;
}

@Injectable()
export class GeminiContractAiService {
  constructor(
    private readonly httpService: HttpService,
    private readonly contractPromptSettingsService: ContractPromptSettingsService,
  ) {}

  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  getModel(): string {
    return process.env.GEMINI_CONTRACT_EXTRACTION_MODEL || 'gemini-2.5-flash-lite';
  }

  async extractItems(args: {
    contract: {
      id: string;
      contractID: string | null;
      tenderId: string;
      tenderPublicId: string | null;
      currency?: string | null;
    };
    documents: GeminiSourceDocument[];
    apiItems?: GeminiApiContractItem[];
  }): Promise<{
    model: string;
    items: AiExtractedContractItem[];
    rawResponse: Record<string, unknown> | null;
    sourceTextLength: number;
    documentsAnalyzed: number;
    usage: ReturnType<typeof summarizeUsageMetrics>;
  }> {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error(
        'Gemini is not configured. Set GEMINI_API_KEY to enable AI extraction.',
      );
    }

    const documents = args.documents
      .map((document) => ({
        ...document,
        extractedText:
          extractTextAfterSpecification(document.extractedText)?.trim() || '',
      }))
      .filter((document) => document.extractedText.length > 0);
    const maxChars = Number.parseInt(
      process.env.GEMINI_CONTRACT_EXTRACTION_MAX_CHARS || '',
      10,
    );
    const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 60_000;
    const boundedDocuments = this.limitDocumentsByCharacters(documents, budget);
    const sourceTextLength = boundedDocuments.reduce(
      (sum, document) => sum + document.extractedText.length,
      0,
    );
    const model = this.getModel();
    const response = await this.generateStructuredItems(
      apiKey,
      model,
      args.contract,
      boundedDocuments,
    );
    const rawText = this.extractResponseText(response);
    const parsed = this.parseItems(rawText);
    const alignedItems = Array.isArray(args.apiItems) && args.apiItems.length > 0
      ? alignAiExtractedItemsToApiItems(
          args.apiItems,
          parsed,
          args.contract.currency ?? null,
        )
      : parsed;
    const usage = summarizeUsageMetrics([
      buildGeminiUsageMetric({
        stage: 'gemini-extraction',
        model,
        response,
      }),
    ]);

    return {
      model,
      items: alignedItems,
      rawResponse: response,
      sourceTextLength,
      documentsAnalyzed: boundedDocuments.length,
      usage,
    };
  }

  private async generateStructuredItems(
    apiKey: string,
    model: string,
    contract: {
      id: string;
      contractID: string | null;
      tenderId: string;
      tenderPublicId: string | null;
    },
    documents: GeminiSourceDocument[],
  ): Promise<Record<string, unknown> | null> {
    const prompts = await this.contractPromptSettingsService.getTemplateValues([
      'gemini_contract_extraction_system',
      'gemini_contract_extraction_user',
    ]);
    const body = {
      systemInstruction: {
        parts: [
          {
            text: prompts.gemini_contract_extraction_system,
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
                documents,
                prompts.gemini_contract_extraction_user,
              ),
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
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

  private buildUserPrompt(
    contract: {
      contractID: string | null;
      tenderPublicId: string | null;
    },
    documents: GeminiSourceDocument[],
    template: string,
  ): string {
    const docsText = documents
      .map((document, index) =>
        [
          `## DOCUMENT ${index + 1}`,
          `title: ${document.title}`,
          `extractionMethod: ${document.extractionMethod || 'unknown'}`,
          'text:',
          document.extractedText,
        ].join('\n'),
      )
      .join('\n\n');

    return this.contractPromptSettingsService.renderTemplate(template, {
      contract_id: contract.contractID || 'unknown',
      tender_id: contract.tenderPublicId || 'unknown',
      documents_text: docsText,
    });
  }

  private getResponseJsonSchema() {
    return {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              documentTitle: { type: 'string' },
              extractionMethod: {
                type: 'string',
                enum: ['pdf-text', 'mistral-ocr'],
              },
              itemName: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string' },
              unitPrice: { type: 'number' },
              totalPrice: { type: 'number' },
              currency: { type: 'string' },
              vat: { type: 'string' },
              sourceSnippet: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['itemName'],
          },
        },
      },
      required: ['items'],
    };
  }

  private extractResponseText(response: Record<string, unknown> | null): string {
    const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
    const parts = Array.isArray((candidates[0] as any)?.content?.parts)
      ? (candidates[0] as any).content.parts
      : [];
    const textPart = parts.find((part: any) => typeof part?.text === 'string');

    if (!textPart?.text) {
      throw new Error('Gemini returned no structured text payload.');
    }

    return String(textPart.text);
  }

  private parseItems(text: string): AiExtractedContractItem[] {
    let parsed: any;

    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Gemini returned invalid JSON.');
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];

    return dedupeAiExtractedItems(
      items
      .map((item: any) => ({
        source: 'document' as const,
        documentTitle:
          typeof item?.documentTitle === 'string' ? item.documentTitle : null,
        extractionMethod:
          item?.extractionMethod === 'pdf-text' ||
          item?.extractionMethod === 'mistral-ocr'
            ? item.extractionMethod
            : null,
        itemName: typeof item?.itemName === 'string' ? item.itemName.trim() : '',
        quantity: this.toNumberOrNull(item?.quantity),
        unit: typeof item?.unit === 'string' ? item.unit : null,
        unitPrice: this.toNumberOrNull(item?.unitPrice),
        totalPrice: this.toNumberOrNull(item?.totalPrice),
        currency: typeof item?.currency === 'string' ? item.currency : null,
        vat: typeof item?.vat === 'string' ? item.vat : null,
        sourceSnippet:
          typeof item?.sourceSnippet === 'string' ? item.sourceSnippet : null,
        confidence: this.toNumberOrNull(item?.confidence),
      }))
      .filter((item: AiExtractedContractItem) => item.itemName.length > 0),
    );
  }

  private toNumberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    return null;
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

      return [
        `Gemini extraction failed for model ${model}`,
        status ? `(HTTP ${status})` : '',
        `: ${apiMessage}`,
      ].join('');
    }

    return error instanceof Error ? error.message : 'Unknown Gemini extraction error';
  }

  private limitDocumentsByCharacters(
    documents: GeminiSourceDocument[],
    budget: number,
  ): GeminiSourceDocument[] {
    const selected: GeminiSourceDocument[] = [];
    let used = 0;

    for (const document of documents) {
      if (used >= budget) {
        break;
      }

      const remaining = budget - used;
      const nextText =
        document.extractedText.length <= remaining
          ? document.extractedText
          : document.extractedText.slice(0, remaining);

      if (!nextText.trim()) {
        continue;
      }

      selected.push({
        ...document,
        extractedText: nextText,
      });
      used += nextText.length;
    }

    return selected;
  }
}
