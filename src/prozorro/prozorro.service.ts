import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timer } from 'rxjs';
import { retry } from 'rxjs/operators';

@Injectable()
export class ProzorroService {
  private readonly logger = new Logger(ProzorroService.name);
  private readonly baseUrl = 'https://public.api.openprocurement.org/api/2.5';

  constructor(private readonly httpService: HttpService) {
    // Refill tokens every second (per-instance — no global Redis coordination)
    setInterval(() => {
      const toRelease = Math.min(
        this.maxTokens - this.tokens,
        this.pendingQueue.length,
      );
      this.tokens = Math.min(this.maxTokens, this.tokens + this.maxTokens);
      for (let i = 0; i < toRelease; i++) {
        this.pendingQueue.shift()!();
        this.tokens--;
      }
    }, 1000);
  }

  // Per-instance rate limiter (token bucket)
  private readonly maxTokens = parseInt(
    process.env.WORKER_REQUESTS_PER_SECOND || '50',
    10,
  );
  private tokens = parseInt(process.env.WORKER_REQUESTS_PER_SECOND || '50', 10);
  private pendingQueue: Array<() => void> = [];

  private acquireRateLimit(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--;
      return Promise.resolve();
    }
    // No tokens available — wait for the next refill
    return new Promise<void>((resolve) => this.pendingQueue.push(resolve));
  }

  private getRetryConfig() {
    return {
      count: 3,
      delay: (error: any, retryCount: number) => {
        this.logger.warn(
          `API Error (${error.message}). Retrying... attempt ${retryCount}`,
        );
        return timer(1000 * retryCount); // Backoff: 1s, 2s, 3s
      },
    };
  }

  async getTendersPage(
    offset?: string,
  ): Promise<{ data: any[]; nextPageOffset: string | null }> {
    try {
      const url = offset
        ? `${this.baseUrl}/tenders?offset=${offset}`
        : `${this.baseUrl}/tenders`;
      this.logger.debug(`Fetching tenders from: ${url}`);

      const response = await firstValueFrom(
        this.httpService.get(url).pipe(retry(this.getRetryConfig())),
      );
      const responseData = response.data;

      return {
        data: responseData.data || [],
        nextPageOffset: responseData.next_page?.offset || null,
      };
    } catch (error) {
      this.logger.error(
        `Error fetching tenders page: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async getTenderDetails(tenderId: string): Promise<any> {
    try {
      // Per-instance rate limit: max WORKER_REQUESTS_PER_SECOND per second on this machine
      await this.acquireRateLimit();

      const url = `${this.baseUrl}/tenders/${tenderId}`;
      this.logger.debug(`Fetching specific tender: ${tenderId}`);

      const response = await firstValueFrom(
        this.httpService.get(url).pipe(retry(this.getRetryConfig())),
      );
      return response.data.data;
    } catch (error) {
      this.logger.error(
        `Error fetching tender ${tenderId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async getContractDetails(tenderId: string, contractId: string): Promise<any> {
    try {
      await this.acquireRateLimit();

      const url = `${this.baseUrl}/contracts/${contractId}`;
      this.logger.debug(`Fetching contract: ${contractId}`);

      const response = await firstValueFrom(
        this.httpService.get(url).pipe(retry(this.getRetryConfig())),
      );
      return response.data.data;
    } catch (error) {
      this.logger.error(
        `Error fetching contract ${contractId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
