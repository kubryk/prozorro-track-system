import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timer } from 'rxjs';
import { retry } from 'rxjs/operators';

@Injectable()
export class ProzorroService {
    private readonly logger = new Logger(ProzorroService.name);
    private readonly baseUrl = 'https://public.api.openprocurement.org/api/2.5';

    constructor(private readonly httpService: HttpService) { }

    private getRetryConfig() {
        return {
            count: 3,
            delay: (error: any, retryCount: number) => {
                this.logger.warn(`API Error (${error.message}). Retrying... attempt ${retryCount}`);
                return timer(1000 * retryCount); // Backoff: 1s, 2s, 3s
            }
        };
    }

    async getTendersPage(offset?: string): Promise<{ data: any[], nextPageOffset: string | null }> {
        try {
            const url = offset ? `${this.baseUrl}/tenders?offset=${offset}` : `${this.baseUrl}/tenders`;
            this.logger.debug(`Fetching tenders from: ${url}`);

            const response = await firstValueFrom(
                this.httpService.get(url).pipe(retry(this.getRetryConfig()))
            );
            const responseData = response.data;

            return {
                data: responseData.data || [],
                nextPageOffset: responseData.next_page?.offset || null,
            };
        } catch (error) {
            this.logger.error(`Error fetching tenders page: ${error.message}`, error.stack);
            throw error;
        }
    }

    async getTenderDetails(tenderId: string): Promise<any> {
        try {
            const url = `${this.baseUrl}/tenders/${tenderId}`;
            this.logger.debug(`Fetching specific tender: ${tenderId}`);

            const response = await firstValueFrom(
                this.httpService.get(url).pipe(retry(this.getRetryConfig()))
            );
            return response.data.data;
        } catch (error) {
            this.logger.error(`Error fetching tender ${tenderId}: ${error.message}`, error.stack);
            throw error;
        }
    }
}
