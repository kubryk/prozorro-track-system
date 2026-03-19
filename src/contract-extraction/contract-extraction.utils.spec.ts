import {
  buildExtractedPriceLines,
  selectRelevantContractDocuments,
} from './contract-extraction.utils';

describe('contract extraction utils', () => {
  it('відбирає тільки релевантні документи для витягування цін', () => {
    const documents = [
      {
        title: 'Додаток 1. Специфікація товару',
        url: 'https://example.com/specification.pdf',
        format: 'application/pdf',
      },
      {
        title: 'Лист погодження',
        url: 'https://example.com/approval.docx',
        format: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ];

    expect(selectRelevantContractDocuments(documents)).toEqual([
      expect.objectContaining({
        title: 'Додаток 1. Специфікація товару',
        mimeType: 'application/pdf',
      }),
    ]);
  });

  it('нормалізує рядки цінової таблиці за заголовками', () => {
    const lines = buildExtractedPriceLines(
      ['Найменування', 'Кількість', 'Од.', 'Ціна за одиницю', 'Сума'],
      [['Бензин А-95', '10', 'л', '58,40', '584,00 грн']],
    );

    expect(lines).toMatchObject([
      {
        cells: ['Бензин А-95', '10', 'л', '58,40', '584,00 грн'],
        normalized: {
          itemName: 'Бензин А-95',
          quantity: 10,
          unit: 'л',
          unitPrice: 58.4,
          totalPrice: 584,
          vat: null,
          currency: 'UAH',
        },
      },
    ]);
  });

  it('ігнорує підсумкові рядки і не плутає ПДВ з ціною', () => {
    const lines = buildExtractedPriceLines(
      [
        '№',
        'Найменування',
        'Одиниця виміру',
        'Кількість',
        'Ціна за одиницю, грн. (без ПДВ)',
        'Сума, грн. (без ПДВ)',
      ],
      [
        [
          '1',
          'Послуги з натирання паркетної підлоги мастикою',
          'кв.м.',
          '653',
          '34,00',
          '22202,00',
        ],
        ['', '', '', '', 'Разом без ПДВ:', '22.202,00'],
      ],
    );

    expect(lines).toMatchObject([
      {
        normalized: {
          itemName: 'Послуги з натирання паркетної підлоги мастикою',
          quantity: 653,
          unit: 'кв.м.',
          unitPrice: 34,
          totalPrice: 22202,
          vat: 'без ПДВ',
        },
      },
      {
        normalized: null,
      },
    ]);
  });
});
