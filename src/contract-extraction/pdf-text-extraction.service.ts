import { Injectable } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import { isUsableExtractedText } from './contract-extraction.utils';

@Injectable()
export class PdfTextExtractionService {
  async extractFromBuffer(content: Buffer): Promise<{
    extractedText: string | null;
    candidatePages: number[] | null;
    tables: [];
    usableText: boolean;
    pageCount: number | null;
  }> {
    const parser = new PDFParse({ data: new Uint8Array(content) });

    try {
      const textResult = await parser.getText();
      const extractedText =
        typeof textResult?.text === 'string' ? textResult.text.trim() || null : null;
      const pageCount =
        typeof (textResult as any)?.numpages === 'number'
          ? (textResult as any).numpages
          : Array.isArray((textResult as any)?.pages)
            ? (textResult as any).pages.length
            : typeof (textResult as any)?.total === 'number'
              ? (textResult as any).total
              : null;

      return {
        extractedText,
        candidatePages: null,
        tables: [],
        usableText: isUsableExtractedText(extractedText),
        pageCount,
      };
    } finally {
      await parser.destroy();
    }
  }
}
