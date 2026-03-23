import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { ExtractedPriceTable } from './contract-extraction.types';
import { buildMistralOcrUsageMetric } from './contract-usage.utils';

@Injectable()
export class MistralOcrService {
  constructor(private readonly httpService: HttpService) {}

  isConfigured(): boolean {
    return Boolean(process.env.MISTRAL_API_KEY);
  }

  async extractFromDocument(input: {
    content: Buffer;
    mimeType: string;
  }): Promise<{
    extractedText: string | null;
    candidatePages: number[] | null;
    tables: ExtractedPriceTable[];
    usage: ReturnType<typeof buildMistralOcrUsageMetric>;
  }> {
    const apiKey = process.env.MISTRAL_API_KEY;

    if (!apiKey) {
      throw new Error(
        'Mistral OCR is not configured. Set MISTRAL_API_KEY to enable OCR fallback.',
      );
    }

    const response = await this.callOcrApi(input.content, input.mimeType, apiKey);
    const pages = Array.isArray(response?.pages) ? response.pages : [];
    const pagePayloads = pages.map((page: any, index: number) => {
      const markdown =
        typeof page?.markdown === 'string'
          ? page.markdown
          : typeof page?.text === 'string'
            ? page.text
            : typeof page?.content === 'string'
              ? page.content
              : '';

      return {
        markdown: markdown.trim(),
      };
    });
    const extractedText = pagePayloads
      .map((page) => page.markdown)
      .filter((value) => value.length > 0)
      .join('\n\n')
      .trim();

    return {
      extractedText: extractedText || null,
      candidatePages: null,
      tables: [],
      usage: buildMistralOcrUsageMetric({
        pageCount: pages.length || null,
        model: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
      }),
    };
  }

  private async callOcrApi(
    content: Buffer,
    mimeType: string,
    apiKey: string,
  ): Promise<Record<string, unknown> | null> {
    const dataUrl = this.buildDataUrl(content, mimeType);
    const requestBody = {
      model: process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest',
      document:
        mimeType === 'application/pdf'
          ? {
              type: 'document_url',
              document_url: dataUrl,
            }
          : {
              type: 'image_url',
              image_url: dataUrl,
            },
      include_image_base64: false,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${process.env.MISTRAL_API_BASE_URL || 'https://api.mistral.ai'}/v1/ocr`,
          requestBody,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
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
      throw new Error(this.buildMistralErrorMessage(error));
    }
  }

  private buildDataUrl(content: Buffer, mimeType: string): string {
    return `data:${mimeType};base64,${content.toString('base64')}`;
  }

  private buildMistralErrorMessage(error: unknown): string {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const apiMessage =
        typeof error.response?.data?.message === 'string'
          ? error.response.data.message
          : typeof error.response?.data?.detail === 'string'
            ? error.response.data.detail
            : error.message;

      return [
        'Mistral OCR request failed',
        status ? `(HTTP ${status})` : '',
        `: ${apiMessage}`,
      ].join('');
    }

    return error instanceof Error ? error.message : 'Unknown Mistral OCR error';
  }
}
