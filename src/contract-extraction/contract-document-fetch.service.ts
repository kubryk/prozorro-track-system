import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class ContractDocumentFetchService {
  constructor(private readonly httpService: HttpService) {}

  async downloadDocument(
    url: string,
    fallbackMimeType: string,
  ): Promise<{ content: Buffer; mimeType: string }> {
    const response = await firstValueFrom(
      this.httpService.get(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxRedirects: 5,
      }),
    );

    const content = Buffer.from(response.data);
    const contentTypeHeader = response.headers['content-type'];
    const headerMimeType =
      typeof contentTypeHeader === 'string' && contentTypeHeader.length > 0
        ? contentTypeHeader.split(';')[0].trim().toLowerCase()
        : '';
    const sniffedMimeType = this.detectMimeTypeFromContent(content);
    const mimeType = this.resolveDocumentMimeType(
      headerMimeType,
      fallbackMimeType,
      sniffedMimeType,
    );

    return {
      content,
      mimeType,
    };
  }

  private resolveDocumentMimeType(
    headerMimeType: string,
    fallbackMimeType: string,
    sniffedMimeType: string | null,
  ): string {
    const normalizedFallbackMimeType = fallbackMimeType.trim().toLowerCase();

    if (sniffedMimeType) {
      return sniffedMimeType;
    }

    if (this.isSupportedMimeType(headerMimeType)) {
      return headerMimeType;
    }

    if (this.isSupportedMimeType(normalizedFallbackMimeType)) {
      return normalizedFallbackMimeType;
    }

    return headerMimeType || normalizedFallbackMimeType || 'application/pdf';
  }

  private isSupportedMimeType(mimeType: string): boolean {
    return ['application/pdf', 'image/png', 'image/jpeg'].includes(mimeType);
  }

  private detectMimeTypeFromContent(content: Buffer): string | null {
    if (content.length >= 5 && content.subarray(0, 5).toString() === '%PDF-') {
      return 'application/pdf';
    }

    if (
      content.length >= 8 &&
      content.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) {
      return 'image/png';
    }

    if (
      content.length >= 3 &&
      content[0] === 0xff &&
      content[1] === 0xd8 &&
      content[2] === 0xff
    ) {
      return 'image/jpeg';
    }

    return null;
  }
}
