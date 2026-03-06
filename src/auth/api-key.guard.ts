import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class ApiKeyGuard implements CanActivate {
    private readonly logger = new Logger(ApiKeyGuard.name);

    canActivate(
        context: ExecutionContext,
    ): boolean | Promise<boolean> | Observable<boolean> {
        const request = context.switchToHttp().getRequest();
        const apiKey = request.headers['x-api-key'];

        const validApiKey = process.env.API_KEY;

        if (!validApiKey) {
            this.logger.error('API_KEY environment variable is not set. Denying all requests for safety.');
            throw new UnauthorizedException('API Key is missing or invalid');
        }

        if (apiKey === validApiKey) {
            return true;
        }

        this.logger.warn(`Failed authentication attempt with API Key: ${apiKey}`);
        throw new UnauthorizedException('API Key is missing or invalid');
    }
}
