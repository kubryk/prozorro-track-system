import { Logger, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common/interfaces';
import { ApiKeyGuard } from './api-key.guard';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.API_KEY = 'secret-key';
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    guard = new ApiKeyGuard();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.API_KEY;
  });

  it('не логуює значення API key при невдалій автентифікації', () => {
    const request = {
      headers: { 'x-api-key': 'leaked-key' },
      method: 'GET',
      originalUrl: '/search/tenders',
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      'Failed authentication attempt for GET /search/tenders; api key provided: true',
    );
  });
});
