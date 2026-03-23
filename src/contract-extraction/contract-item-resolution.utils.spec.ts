import { resolveContractItems } from './contract-item-resolution.utils';
import { ContractExtractionResult } from './contract-extraction.types';

describe('contract item resolution utils', () => {
  function buildExtractionResult(
    lines: Array<{
      itemName?: string | null;
      quantity?: number | null;
      unit?: string | null;
      unitPrice?: number | null;
      totalPrice?: number | null;
      currency?: string | null;
    }>,
  ): ContractExtractionResult {
    return {
      status: 'completed',
      contract: {
        id: 'contract-id',
        contractID: 'UA-2026-01-01-000001-a-c1',
        tenderId: 'tender-id',
        tenderPublicId: 'UA-2026-01-01-000001-a',
      },
      totalDocuments: 1,
      relevantDocuments: 1,
      processedDocuments: 1,
      usageSummary: null,
      documents: [
        {
          title: 'Специфікація.pdf',
          url: 'https://example.com/specification.pdf',
          mimeType: 'application/pdf',
          matchedKeywords: ['специфікація'],
          extractionMethod: 'pdf-text',
          extractedText: 'Специфікація до договору',
          candidatePages: [2],
          usage: null,
          tables: [
            {
              page: 2,
              headers: ['Найменування', 'Кількість', 'Од.', 'Ціна', 'Сума'],
              confidence: 0.94,
              lines: lines.map((line, index) => ({
                rowIndex: index,
                cells: [],
                normalized: {
                  itemName: line.itemName ?? null,
                  quantity: line.quantity ?? null,
                  unit: line.unit ?? null,
                  unitPrice: line.unitPrice ?? null,
                  totalPrice: line.totalPrice ?? null,
                  vat: null,
                  currency: line.currency ?? null,
                },
              })),
            },
          ],
        },
      ],
    };
  }

  it('залишає ціну з API, якщо вона вже є', () => {
    const resolved = resolveContractItems(
      [
        {
          description: 'Фарба для підлоги',
          quantity: 12,
          unit: {
            name: 'л',
            value: {
              amount: 180,
              currency: 'UAH',
            },
          },
        },
      ],
      buildExtractionResult([
        {
          itemName: 'Фарба для підлоги',
          quantity: 12,
          unit: 'л',
          unitPrice: 195,
          totalPrice: 2340,
          currency: 'UAH',
        },
      ]),
      'UAH',
    );

    expect(resolved).toMatchObject([
      {
        apiUnitPrice: 180,
        resolvedUnitPrice: 180,
        resolvedTotalPrice: 2160,
        priceSource: 'conflict',
      },
    ]);
  });

  it('підтягує ціну з документа, якщо в API її немає', () => {
    const resolved = resolveContractItems(
      [
        {
          description: 'Послуги з натирання паркетної підлоги мастикою',
          quantity: 653,
          unit: {
            name: 'кв.м.',
          },
          classification: {
            id: '98310000-9',
            description: 'Послуги з прання і сухого чищення',
          },
        },
      ],
      buildExtractionResult([
        {
          itemName: 'Послуги з натирання паркетної підлоги мастикою',
          quantity: 653,
          unit: 'кв.м.',
          unitPrice: 34,
          totalPrice: 22202,
          currency: 'UAH',
        },
      ]),
      'UAH',
    );

    expect(resolved).toMatchObject([
      {
        apiUnitPrice: null,
        documentUnitPrice: 34,
        documentTotalPrice: 22202,
        resolvedUnitPrice: 34,
        resolvedTotalPrice: 22202,
        priceSource: 'document',
        matchedDocument: {
          documentTitle: 'Специфікація.pdf',
          page: 2,
        },
      },
    ]);
  });

  it('виводить ціну за одиницю з загальної суми документа, якщо в рядку немає unit price', () => {
    const resolved = resolveContractItems(
      [
        {
          description: 'Миття вікон',
          quantity: 48,
          unit: {
            name: 'м2',
          },
        },
      ],
      buildExtractionResult([
        {
          itemName: 'Миття вікон',
          quantity: 48,
          unit: 'м2',
          totalPrice: 4584,
          currency: 'UAH',
        },
      ]),
      'UAH',
    );

    expect(resolved).toMatchObject([
      {
        resolvedUnitPrice: 95.5,
        resolvedTotalPrice: 4584,
        priceSource: 'document-derived',
      },
    ]);
  });

  it('не матчить випадковий рядок з документа без достатнього збігу', () => {
    const resolved = resolveContractItems(
      [
        {
          description: 'Лак для деревини',
          quantity: 3,
          unit: {
            name: 'шт',
          },
        },
      ],
      buildExtractionResult([
        {
          itemName: 'Фарба фасадна',
          quantity: 18,
          unit: 'л',
          unitPrice: 220,
          totalPrice: 3960,
          currency: 'UAH',
        },
      ]),
      'UAH',
    );

    expect(resolved).toMatchObject([
      {
        documentUnitPrice: null,
        resolvedUnitPrice: null,
        priceSource: 'missing',
        matchedDocument: null,
      },
    ]);
  });

  it('матчить API-позицію навіть якщо в документі назва коротша, але по суті та сама', () => {
    const resolved = resolveContractItems(
      [
        {
          description: 'Послуги з натирання паркетної підлоги мастикою',
          quantity: 653,
          unit: {
            name: 'кв.м.',
          },
        },
      ],
      buildExtractionResult([
        {
          itemName: 'Натирання паркетної підлоги мастикою',
          quantity: 653,
          unit: 'кв.м.',
          unitPrice: 34,
          totalPrice: 22202,
          currency: 'UAH',
        },
      ]),
      'UAH',
    );

    expect(resolved).toMatchObject([
      {
        documentUnitPrice: 34,
        resolvedUnitPrice: 34,
        priceSource: 'document',
        matchedDocument: {
          documentTitle: 'Специфікація.pdf',
        },
      },
    ]);
  });

  it('не матчить іншу позицію тільки через спільні загальні слова', () => {
    const resolved = resolveContractItems(
      [
        {
          description: 'Послуги з поточного ремонту покрівлі',
          quantity: 1,
          unit: {
            name: 'послуга',
          },
        },
      ],
      buildExtractionResult([
        {
          itemName: 'Послуги з прибирання приміщень',
          quantity: 1,
          unit: 'послуга',
          unitPrice: 50000,
          totalPrice: 50000,
          currency: 'UAH',
        },
      ]),
      'UAH',
    );

    expect(resolved).toMatchObject([
      {
        documentUnitPrice: null,
        resolvedUnitPrice: null,
        priceSource: 'missing',
        matchedDocument: null,
      },
    ]);
  });
});
