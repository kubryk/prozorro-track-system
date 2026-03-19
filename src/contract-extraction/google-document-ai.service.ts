import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ContractDocumentCandidate,
  ExtractedPriceTable,
} from './contract-extraction.types';
import { buildExtractedPriceLines } from './contract-extraction.utils';

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

interface TokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

@Injectable()
export class GoogleDocumentAiService {
  private tokenCache: TokenCacheEntry | null = null;

  constructor(private readonly httpService: HttpService) {}

  isConfigured(): boolean {
    return Boolean(
      this.getProjectId() &&
        this.getLocation() &&
        this.getFormProcessorId() &&
        this.getCredentialsSource(),
    );
  }

  async extractPriceTablesFromUrl(
    document: ContractDocumentCandidate,
  ): Promise<{
    candidatePages: number[] | null;
    tables: ExtractedPriceTable[];
  }> {
    const downloaded = await this.downloadDocument(document.url, document.mimeType);
    const candidatePages = await this.detectCandidatePages(
      downloaded.content,
      downloaded.mimeType,
    );
    const processedDocument = await this.processDocument(
      downloaded.content,
      downloaded.mimeType,
      this.getFormProcessorId(),
      candidatePages,
    );

    return {
      candidatePages,
      tables: this.extractTables(processedDocument),
    };
  }

  private async detectCandidatePages(
    content: Buffer,
    mimeType: string,
  ): Promise<number[] | null> {
    const layoutProcessorId = this.getLayoutProcessorId();

    if (!layoutProcessorId) {
      return null;
    }

    let layoutDocument: any;

    try {
      layoutDocument = await this.processDocument(
        content,
        mimeType,
        layoutProcessorId,
      );
    } catch {
      // Layout detection is an optional optimization. If it fails, fall back
      // to processing the whole document with the form parser.
      return null;
    }
    const pages = Array.isArray(layoutDocument?.pages)
      ? layoutDocument.pages
      : [];

    const pagesWithTables = pages
      .filter(
        (page: any) => Array.isArray(page?.tables) && page.tables.length > 0,
      )
      .map((page: any) => Number(page.pageNumber))
      .filter(
        (pageNumber: number) =>
          Number.isFinite(pageNumber) && pageNumber > 0,
      );

    return pagesWithTables.length > 0 ? pagesWithTables : null;
  }

  private async processDocument(
    content: Buffer,
    mimeType: string,
    processorId: string,
    pages?: number[] | null,
  ): Promise<any> {
    const accessToken = await this.getAccessToken();
    const requestBody: Record<string, unknown> = {
      rawDocument: {
        content: content.toString('base64'),
        mimeType,
      },
    };

    if (pages && pages.length > 0) {
      requestBody.processOptions = {
        individualPageSelector: {
          pages,
        },
      };
    }

    let response;

    try {
      response = await firstValueFrom(
        this.httpService.post(
          this.buildProcessorUrl(processorId),
          requestBody,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
            timeout: 120000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          },
        ),
      );
    } catch (error) {
      throw new Error(this.buildGoogleApiErrorMessage(error, processorId));
    }

    return response.data?.document ?? null;
  }

  private buildGoogleApiErrorMessage(
    error: unknown,
    processorId: string,
  ): string {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const apiError = error.response?.data?.error;
      const message =
        typeof apiError?.message === 'string'
          ? apiError.message
          : error.message;
      const details = Array.isArray(apiError?.details)
        ? apiError.details
            .map((detail: unknown) =>
              typeof detail === 'string' ? detail : JSON.stringify(detail),
            )
            .join(' | ')
        : '';

      return [
        `Google Document AI request failed for processor ${processorId}`,
        status ? `(HTTP ${status})` : '',
        `: ${message}`,
        details ? ` Details: ${details}` : '',
      ].join('');
    }

    return error instanceof Error
      ? error.message
      : 'Unknown Google Document AI error';
  }

  private extractTables(document: any): ExtractedPriceTable[] {
    const pages = Array.isArray(document?.pages) ? document.pages : [];
    const text = typeof document?.text === 'string' ? document.text : '';
    const tables: ExtractedPriceTable[] = [];

    for (const page of pages) {
      const pageNumber = Number(page?.pageNumber) || 1;
      const pageTables = Array.isArray(page?.tables) ? page.tables : [];

      for (const table of pageTables) {
        const headerRows = Array.isArray(table?.headerRows) ? table.headerRows : [];
        const bodyRows = Array.isArray(table?.bodyRows) ? table.bodyRows : [];
        const headers = this.extractHeaderCells(headerRows, text);
        const rows = bodyRows.map((row: any) =>
          Array.isArray(row?.cells)
            ? row.cells.map((cell: any) => this.extractLayoutText(text, cell?.layout))
            : [],
        );

        tables.push({
          page: pageNumber,
          headers,
          confidence:
            typeof table?.layout?.confidence === 'number'
              ? table.layout.confidence
              : null,
          lines: buildExtractedPriceLines(headers, rows),
        });
      }
    }

    return tables;
  }

  private extractHeaderCells(headerRows: any[], fullText: string): string[] {
    if (headerRows.length === 0) {
      return [];
    }

    const lastHeaderRow = headerRows[headerRows.length - 1];
    const cells = Array.isArray(lastHeaderRow?.cells) ? lastHeaderRow.cells : [];

    return cells.map((cell: any) => this.extractLayoutText(fullText, cell?.layout));
  }

  private extractLayoutText(fullText: string, layout: any): string {
    const textSegments = Array.isArray(layout?.textAnchor?.textSegments)
      ? layout.textAnchor.textSegments
      : [];

    if (textSegments.length === 0) {
      return '';
    }

    return textSegments
      .map((segment: any) => {
        const startIndex = segment?.startIndex
          ? Number(segment.startIndex)
          : 0;
        const endIndex = segment?.endIndex ? Number(segment.endIndex) : 0;

        if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) {
          return '';
        }

        return fullText.slice(startIndex, endIndex);
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async downloadDocument(
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

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 30_000) {
      return this.tokenCache.accessToken;
    }

    const credentials = await this.loadServiceAccountCredentials();
    const now = Math.floor(Date.now() / 1000);
    const assertion = this.createJwtAssertion(credentials, now);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const response = await firstValueFrom(
      this.httpService.post('https://oauth2.googleapis.com/token', body.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      }),
    );

    const accessToken = response.data?.access_token;
    const expiresIn = Number(response.data?.expires_in || 3600);

    this.tokenCache = {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    return accessToken;
  }

  private createJwtAssertion(
    credentials: ServiceAccountCredentials,
    now: number,
  ): string {
    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };
    const payload = {
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;
    const signer = createSign('RSA-SHA256');

    signer.update(unsignedToken);
    signer.end();

    const signature = signer.sign(credentials.private_key);
    return `${unsignedToken}.${this.base64UrlEncode(signature)}`;
  }

  private base64UrlEncode(value: string | Buffer): string {
    return Buffer.from(value)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private async loadServiceAccountCredentials(): Promise<ServiceAccountCredentials> {
    const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (inlineJson) {
      return JSON.parse(inlineJson) as ServiceAccountCredentials;
    }

    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (!credentialsPath) {
      throw new Error(
        'Google credentials are not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.',
      );
    }

    const rawCredentials = await readFile(credentialsPath, 'utf8');
    return JSON.parse(rawCredentials) as ServiceAccountCredentials;
  }

  private buildProcessorUrl(processorId: string): string {
    return [
      `https://${this.getLocation()}-documentai.googleapis.com/v1`,
      `projects/${this.getProjectId()}`,
      `locations/${this.getLocation()}`,
      `processors/${processorId}:process`,
    ].join('/');
  }

  private getProjectId(): string {
    return process.env.GOOGLE_CLOUD_PROJECT_ID || '';
  }

  private getLocation(): string {
    return process.env.GOOGLE_DOCUMENT_AI_LOCATION || 'eu';
  }

  private getLayoutProcessorId(): string {
    return process.env.GOOGLE_DOCUMENT_AI_LAYOUT_PROCESSOR_ID || '';
  }

  private getFormProcessorId(): string {
    return process.env.GOOGLE_DOCUMENT_AI_FORM_PROCESSOR_ID || '';
  }

  private getCredentialsSource(): string | undefined {
    return (
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    );
  }
}
