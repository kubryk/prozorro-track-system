import {
  buildExtractedPriceLines,
  buildExtractedPriceTablesFromArrays,
  extractTextAfterSpecification,
  hasPriceExtractionSignal,
  isUsableExtractedText,
  parseMarkdownTables,
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

  it('віддає пріоритет документам зі словом "Специфікація" в назві', () => {
    const documents = [
      {
        title: 'Додаток 2 до договору',
        url: 'https://example.com/appendix.pdf',
        format: 'application/pdf',
      },
      {
        title: 'Специфікація до договору',
        url: 'https://example.com/spec.pdf',
        format: 'application/pdf',
      },
      {
        title: 'Локальний кошторис',
        url: 'https://example.com/estimate.pdf',
        format: 'application/pdf',
      },
    ];

    const candidates = selectRelevantContractDocuments(documents);

    expect(candidates[0]).toMatchObject({
      title: 'Специфікація до договору',
      mimeType: 'application/pdf',
    });
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Додаток 2 до договору',
          mimeType: 'application/pdf',
        }),
      ]),
    );
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

  it('евристично знаходить кількість, одиницю, ціну і суму навіть з нейтральними заголовками', () => {
    const lines = buildExtractedPriceLines(
      ['Колонка 1', 'Колонка 2', 'Колонка 3', 'Колонка 4', 'Колонка 5'],
      [['Фарба для підлоги', '12', 'л', '180,00', '2160,00']],
    );

    expect(lines).toMatchObject([
      {
        normalized: {
          itemName: 'Фарба для підлоги',
          quantity: 12,
          unit: 'л',
          unitPrice: 180,
          totalPrice: 2160,
        },
      },
    ]);
  });

  it('бачить валюту і кількість по позиціях із заголовків таблиці', () => {
    const lines = buildExtractedPriceLines(
      [
        'Найменування робіт',
        'Од. виміру',
        'Обсяг',
        'Вартість за 1 од., грн',
        'Загальна вартість, грн',
      ],
      [['Миття вікон', 'м2', '48', '95,50', '4584,00']],
    );

    expect(lines).toMatchObject([
      {
        normalized: {
          itemName: 'Миття вікон',
          quantity: 48,
          unit: 'м2',
          unitPrice: 95.5,
          totalPrice: 4584,
          currency: 'UAH',
        },
      },
    ]);
  });

  it('парсить markdown-таблиці після OCR fallback', () => {
    const tables = parseMarkdownTables(`
| Найменування | Кількість | Од. | Ціна | Сума |
| --- | ---: | --- | ---: | ---: |
| Мило рідке | 25 | л | 82,50 | 2062,50 |
    `);

    expect(tables).toEqual([
      [
        ['Найменування', 'Кількість', 'Од.', 'Ціна', 'Сума'],
        ['Мило рідке', '25', 'л', '82,50', '2062,50'],
      ],
    ]);
  });

  it('будує цінові таблиці з уже розпізнаних row arrays', () => {
    const tables = buildExtractedPriceTablesFromArrays(4, [
      [
        ['Найменування', 'Кількість', 'Од.', 'Ціна', 'Сума'],
        ['Мило рідке', '25', 'л', '82,50', '2062,50'],
      ],
    ]);

    expect(tables).toMatchObject([
      {
        page: 4,
        headers: ['Найменування', 'Кількість', 'Од.', 'Ціна', 'Сума'],
        lines: [
          {
            normalized: {
              itemName: 'Мило рідке',
              quantity: 25,
              unit: 'л',
              unitPrice: 82.5,
              totalPrice: 2062.5,
            },
          },
        ],
      },
    ]);
  });

  it('вважає текст придатним лише коли там справді є змістовний PDF text layer', () => {
    expect(isUsableExtractedText('   ')).toBe(false);
    expect(isUsableExtractedText('12 34 56 78')).toBe(false);
    expect(
      isUsableExtractedText(
        'Специфікація до договору поставки мийних засобів. Найменування товару, кількість, одиниця виміру, ціна та загальна сума.',
      ),
    ).toBe(true);
  });

  it('бачить ціновий сигнал у текстовому PDF без OCR, якщо є табличні поля', () => {
    expect(
      hasPriceExtractionSignal(
        'Специфікація. Найменування товару, кількість, одиниця виміру, ціна за одиницю, сума.',
        [],
      ),
    ).toBe(true);
  });

  it('не вважає звичайний договірний текст ціновим сигналом', () => {
    expect(
      hasPriceExtractionSignal(
        'Сторони погодили умови поставки товару, порядок розрахунків та відповідальність сторін.',
        [],
      ),
    ).toBe(false);
  });

  it('бере тільки текст після слова "Специфікація", якщо воно є в документі', () => {
    expect(
      extractTextAfterSpecification(
        'Договір поставки\nУмови оплати та відповідальність сторін.\nСпецифікація:\nНайменування товару\nБензин А-95',
      ),
    ).toBe('Найменування товару\nБензин А-95');
  });

  it('залишає весь текст, якщо слова "Специфікація" в документі немає', () => {
    expect(
      extractTextAfterSpecification(
        'Найменування товару\nКількість\nЦіна за одиницю',
      ),
    ).toBe('Найменування товару\nКількість\nЦіна за одиницю');
  });
});
