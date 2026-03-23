import { Injectable } from '@nestjs/common';
import {
  ContractDocumentCandidate,
  ExtractedDocumentResult,
} from './contract-extraction.types';
import { ContractDocumentFetchService } from './contract-document-fetch.service';
import { PdfTextExtractionService } from './pdf-text-extraction.service';
import { MistralOcrService } from './mistral-ocr.service';
import { hasPriceExtractionSignal } from './contract-extraction.utils';
import { buildPdfTextUsageMetric } from './contract-usage.utils';

@Injectable()
export class ContractDocumentExtractionService {
  constructor(
    private readonly documentFetchService: ContractDocumentFetchService,
    private readonly pdfTextExtractionService: PdfTextExtractionService,
    private readonly mistralOcrService: MistralOcrService,
  ) {}

  isOcrConfigured(): boolean {
    return this.mistralOcrService.isConfigured();
  }

  async extract(
    document: ContractDocumentCandidate,
  ): Promise<ExtractedDocumentResult> {
    const downloaded = await this.documentFetchService.downloadDocument(
      document.url,
      document.mimeType,
    );

    if (downloaded.mimeType === 'application/pdf') {
      const pdfResult = await this.safeExtractPdfText(downloaded.content);
      const hasPriceSignal = hasPriceExtractionSignal(
        pdfResult.extractedText,
        pdfResult.tables,
      );

      if (pdfResult.usableText && (hasPriceSignal || !this.mistralOcrService.isConfigured())) {
        return {
          title: document.title,
          url: document.url,
          mimeType: downloaded.mimeType,
          matchedKeywords: document.matchedKeywords,
          extractionMethod: 'pdf-text',
          extractedText: pdfResult.extractedText,
          candidatePages: pdfResult.candidatePages,
          tables: pdfResult.tables,
          usage: buildPdfTextUsageMetric(pdfResult.pageCount),
        };
      }
    }

    if (!this.mistralOcrService.isConfigured()) {
      throw new Error(
        'Mistral OCR is not configured. Set MISTRAL_API_KEY to enable OCR fallback.',
      );
    }

    const ocrResult = await this.mistralOcrService.extractFromDocument({
      content: downloaded.content,
      mimeType: downloaded.mimeType,
    });

    return {
      title: document.title,
      url: document.url,
      mimeType: downloaded.mimeType,
      matchedKeywords: document.matchedKeywords,
      extractionMethod: 'mistral-ocr',
      extractedText: ocrResult.extractedText,
      candidatePages: ocrResult.candidatePages,
      tables: ocrResult.tables,
      usage: ocrResult.usage,
    };
  }

  private async safeExtractPdfText(content: Buffer) {
    try {
      return await this.pdfTextExtractionService.extractFromBuffer(content);
    } catch {
      return {
        extractedText: null,
        candidatePages: null,
        tables: [],
        usableText: false,
        pageCount: null,
      };
    }
  }
}
