export const CONTRACT_PRICE_EXTRACTION_QUEUE = 'contract-price-extraction';

export const CONTRACT_PRICE_KEYWORDS = [
  'специфікація',
  'додаток',
  'калькуляція',
  'кошторис',
  'цінова',
  'перелік',
  'ціна',
  'вартість',
  'quantity',
  'unit price',
  'price',
  'pricing',
] as const;

export const PRICE_HEADER_ALIASES = {
  itemName: [
    'найменування',
    'назва',
    'номенклатура',
    'товар',
    'послуга',
    'предмет',
    'item',
    'description',
  ],
  quantity: ['кількість', 'к-ть', 'qty', 'quantity', 'обсяг'],
  unit: ['од', 'од.', 'одиниця', 'unit', 'measure'],
  unitPrice: [
    'ціна',
    'ціна за одиницю',
    'ціна за 1',
    'unit price',
    'price per unit',
  ],
  totalPrice: ['сума', 'вартість', 'всього', 'разом', 'total', 'amount'],
  vat: ['пдв', 'vat'],
} as const;
