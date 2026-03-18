import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { SearchContractsQueryDto } from './search-contracts-query.dto';
import { SearchTendersQueryDto } from './search-tenders-query.dto';

describe('Search query validation', () => {
  const validationPipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  async function transformQuery<T>(
    value: Record<string, unknown>,
    metatype: new () => T,
  ): Promise<T> {
    return validationPipe.transform(value, {
      type: 'query',
      metatype,
      data: '',
    } as ArgumentMetadata) as Promise<T>;
  }

  it('перетворює валідний query пошуку тендерів у DTO з числами', async () => {
    await expect(
      transformQuery(
        {
          edrpou: '3077403474',
          role: 'supplier',
          dateFrom: '2026-01-01',
          priceFrom: '1000.5',
          skip: '5',
          take: '25',
        },
        SearchTendersQueryDto,
      ),
    ).resolves.toMatchObject({
      edrpou: '3077403474',
      role: ['supplier'],
      dateFrom: '2026-01-01',
      priceFrom: 1000.5,
      skip: 5,
      take: 25,
    });
  });

  it('підтримує comma-separated ролі й статуси для пошуку тендерів', async () => {
    await expect(
      transformQuery(
        {
          role: 'customer,supplier',
          status: 'active,complete',
        },
        SearchTendersQueryDto,
      ),
    ).resolves.toMatchObject({
      role: ['customer', 'supplier'],
      status: ['active', 'complete'],
    });
  });

  it('підтримує comma-separated ролі й статуси для пошуку контрактів', async () => {
    await expect(
      transformQuery(
        {
          role: 'supplier,customer',
          status: 'active,terminated',
        },
        SearchContractsQueryDto,
      ),
    ).resolves.toMatchObject({
      role: ['supplier', 'customer'],
      status: ['active', 'terminated'],
    });
  });

  it('відхиляє некоректні дати й числа для пошуку тендерів', async () => {
    await expect(
      transformQuery(
        {
          edrpou: '123456789',
          dateFrom: 'not-a-date',
          priceTo: 'NaN',
          take: '1000',
        },
        SearchTendersQueryDto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('відхиляє некоректний dateType для пошуку контрактів', async () => {
    await expect(
      transformQuery(
        {
          dateType: 'awardPeriodStart',
        },
        SearchContractsQueryDto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('відхиляє некоректний sort для пошуку тендерів', async () => {
    await expect(
      transformQuery(
        {
          sort: 'newestFirst',
        },
        SearchTendersQueryDto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('відхиляє некоректний sort для пошуку контрактів', async () => {
    await expect(
      transformQuery(
        {
          sort: 'priceHigh',
        },
        SearchContractsQueryDto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
