import { dedupeAiExtractedItems } from './ai-extracted-items.utils';
import { AiExtractedContractItem } from './contract-extraction.types';

describe('ai extracted items utils', () => {
  function buildItem(
    overrides: Partial<AiExtractedContractItem>,
  ): AiExtractedContractItem {
    return {
      source: 'document',
      documentTitle: null,
      extractionMethod: 'pdf-text',
      itemName: 'Послуги з натирання паркетної підлоги мастикою',
      quantity: 653,
      unit: 'кв.м.',
      unitPrice: 34,
      totalPrice: 22202,
      currency: 'UAH',
      vat: null,
      sourceSnippet: null,
      confidence: null,
      ...overrides,
    };
  }

  it('прибирає дублікати однієї і тієї ж позиції з різних документів', () => {
    const items = dedupeAiExtractedItems([
      buildItem({
        documentTitle: 'Специфікація.pdf',
        sourceSnippet: 'Послуги з натирання паркетної підлоги мастикою 653 кв.м. 34,00',
        confidence: 0.78,
      }),
      buildItem({
        documentTitle: 'Додаток до договору.pdf',
        sourceSnippet: 'Натирання паркетної підлоги мастикою, кількість 653, ціна 34,00',
        confidence: 0.92,
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      quantity: 653,
      unit: 'кв.м.',
      unitPrice: 34,
      totalPrice: 22202,
      confidence: 0.92,
    });
  });

  it('не зливає різні позиції з близькими назвами, якщо відрізняються числа', () => {
    const items = dedupeAiExtractedItems([
      buildItem({
        itemName: 'Фарба для підлоги',
        quantity: 12,
        unit: 'л',
        unitPrice: 180,
        totalPrice: 2160,
      }),
      buildItem({
        itemName: 'Фарба для підлоги',
        quantity: 24,
        unit: 'л',
        unitPrice: 180,
        totalPrice: 4320,
      }),
    ]);

    expect(items).toHaveLength(2);
  });

  it('зберігає більш повний запис, якщо в дублікаті більше заповнених полів', () => {
    const items = dedupeAiExtractedItems([
      buildItem({
        documentTitle: 'Специфікація.pdf',
        totalPrice: null,
        currency: null,
        confidence: 0.6,
      }),
      buildItem({
        documentTitle: 'Специфікація 2.pdf',
        totalPrice: 22202,
        currency: 'UAH',
        confidence: 0.8,
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      totalPrice: 22202,
      currency: 'UAH',
      confidence: 0.8,
    });
  });
});
