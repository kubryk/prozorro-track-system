import { alignAiExtractedItemsToApiItems } from './ai-extracted-items-alignment.utils';
import { AiExtractedContractItem } from './contract-extraction.types';

describe('ai extracted items alignment utils', () => {
  function buildExtractedItem(
    overrides: Partial<AiExtractedContractItem>,
  ): AiExtractedContractItem {
    return {
      source: 'document',
      documentTitle: 'Специфікація.pdf',
      extractionMethod: 'pdf-text',
      itemName: 'Послуги з натирання паркетної підлоги мастикою',
      quantity: 653,
      unit: 'кв.м.',
      unitPrice: 34,
      totalPrice: 22202,
      currency: 'UAH',
      vat: null,
      sourceSnippet: null,
      confidence: 0.82,
      ...overrides,
    };
  }

  it('повертає рівно стільки рядків, скільки предметів у API', () => {
    const apiItems = [
      {
        description: 'Послуги з натирання паркетної підлоги мастикою',
        quantity: 653,
        unit: { name: 'кв.м.' },
      },
      {
        description: 'Миття вікон',
        quantity: 48,
        unit: { name: 'м2' },
      },
    ];

    const extractedItems = [
      buildExtractedItem({ documentTitle: 'Специфікація 1.pdf' }),
      buildExtractedItem({ documentTitle: 'Специфікація 2.pdf' }),
      buildExtractedItem({
        itemName: 'Миття вікон',
        quantity: 48,
        unit: 'м2',
        unitPrice: 95.5,
        totalPrice: 4584,
      }),
    ];

    const aligned = alignAiExtractedItemsToApiItems(apiItems, extractedItems, 'UAH');

    expect(aligned).toHaveLength(2);
    expect(aligned[0]).toMatchObject({
      itemName: 'Послуги з натирання паркетної підлоги мастикою',
      quantity: 653,
      unitPrice: 34,
    });
    expect(aligned[1]).toMatchObject({
      itemName: 'Миття вікон',
      quantity: 48,
      unitPrice: 95.5,
      source: 'document',
    });
  });

  it('підставляє fallback з API, якщо AI не знайшов позицію', () => {
    const apiItems = [
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
    ];

    const aligned = alignAiExtractedItemsToApiItems(apiItems, [], 'UAH');

    expect(aligned).toEqual([
      expect.objectContaining({
        itemName: 'Фарба для підлоги',
        quantity: 12,
        unit: 'л',
        unitPrice: 180,
        totalPrice: 2160,
        currency: 'UAH',
        source: 'api-fallback',
      }),
    ]);
  });
});
