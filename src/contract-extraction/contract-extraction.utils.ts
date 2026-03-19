import {
  CONTRACT_PRICE_KEYWORDS,
  PRICE_HEADER_ALIASES,
} from './contract-extraction.constants';
import {
  ContractDocumentCandidate,
  ExtractedPriceLine,
  NormalizedPriceLine,
} from './contract-extraction.types';

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function detectMimeType(url: string, format?: string | null): string {
  const normalizedFormat = normalizeText(format);

  if (normalizedFormat.includes('pdf') || url.toLowerCase().endsWith('.pdf')) {
    return 'application/pdf';
  }

  if (normalizedFormat.includes('png') || url.toLowerCase().endsWith('.png')) {
    return 'image/png';
  }

  if (
    normalizedFormat.includes('jpg') ||
    normalizedFormat.includes('jpeg') ||
    url.toLowerCase().endsWith('.jpg') ||
    url.toLowerCase().endsWith('.jpeg')
  ) {
    return 'image/jpeg';
  }

  return 'application/octet-stream';
}

function canProcessMimeType(mimeType: string): boolean {
  return [
    'application/pdf',
    'image/png',
    'image/jpeg',
  ].includes(mimeType);
}

function scoreContractDocument(document: any): ContractDocumentCandidate | null {
  const url = document?.url;

  if (typeof url !== 'string' || url.trim() === '') {
    return null;
  }

  const title = String(document?.title || 'Без назви');
  const format = document?.format ? String(document.format) : null;
  const description = document?.description ? String(document.description) : null;
  const documentType = document?.documentType ? String(document.documentType) : null;
  const mimeType = detectMimeType(url, format);

  if (!canProcessMimeType(mimeType)) {
    return null;
  }

  const searchableText = normalizeText(
    [title, description, documentType, format].filter(Boolean).join(' '),
  );
  const matchedKeywords = CONTRACT_PRICE_KEYWORDS.filter((keyword) =>
    searchableText.includes(keyword),
  );

  let relevanceScore = matchedKeywords.length * 2;

  if (mimeType === 'application/pdf') {
    relevanceScore += 1;
  }

  if (normalizeText(documentType).includes('technicalSpecifications')) {
    relevanceScore += 3;
  }

  if (relevanceScore === 0) {
    return null;
  }

  return {
    title,
    url,
    mimeType,
    format,
    description,
    documentType,
    relevanceScore,
    matchedKeywords: [...matchedKeywords],
  };
}

export function selectRelevantContractDocuments(
  documents: unknown[],
): ContractDocumentCandidate[] {
  const candidates = Array.isArray(documents)
    ? documents
        .map((document) => scoreContractDocument(document))
        .filter((candidate): candidate is ContractDocumentCandidate =>
          candidate !== null,
        )
    : [];

  const uniqueByUrl = new Map<string, ContractDocumentCandidate>();

  for (const candidate of candidates) {
    const existing = uniqueByUrl.get(candidate.url);

    if (!existing || existing.relevanceScore < candidate.relevanceScore) {
      uniqueByUrl.set(candidate.url, candidate);
    }
  }

  return [...uniqueByUrl.values()].sort(
    (left, right) => right.relevanceScore - left.relevanceScore,
  );
}

function normalizeHeader(value: string): string {
  return normalizeText(value).replace(/[^\p{L}\p{N}\s]/gu, '');
}

function findHeaderIndex(headers: string[], aliases: readonly string[]): number {
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));

  return normalizedHeaders.findIndex((header) =>
    aliases.some((alias) => header.includes(alias)),
  );
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const cleaned = value
    .replace(/\s+/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(/,(?=\d{1,2}$)/, '.')
    .replace(/,(?=\d{3}\b)/g, '');

  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function detectCurrency(cells: string[]): string | null {
  const joined = normalizeText(cells.join(' '));

  if (joined.includes('uah') || joined.includes('грн')) {
    return 'UAH';
  }

  if (joined.includes('eur') || joined.includes('євро')) {
    return 'EUR';
  }

  if (joined.includes('usd') || joined.includes('дол')) {
    return 'USD';
  }

  return null;
}

function detectVat(cells: string[]): string | null {
  const joined = normalizeText(cells.join(' '));

  if (joined.includes('без пдв')) {
    return 'без ПДВ';
  }

  if (joined.includes('пдв') || joined.includes('vat')) {
    return 'з ПДВ';
  }

  return null;
}

function normalizeVatValue(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (normalized.includes('без пдв')) {
    return 'без ПДВ';
  }

  if (normalized.includes('пдв') || normalized.includes('vat')) {
    return 'з ПДВ';
  }

  return null;
}

function isSummaryRow(cells: string[]): boolean {
  const joined = normalizeText(cells.join(' '));

  return [
    'разом',
    'всього',
    'усього',
    'итого',
    'subtotal',
    'total',
  ].some((keyword) => joined.includes(keyword));
}

function buildNormalizedPriceLine(
  headers: string[],
  cells: string[],
): NormalizedPriceLine | null {
  const itemNameIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.itemName);
  const quantityIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.quantity);
  const unitIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.unit);
  const unitPriceIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.unitPrice);
  const totalPriceIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.totalPrice);
  const vatIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.vat);

  const hasStructuredColumns =
    itemNameIndex >= 0 ||
    quantityIndex >= 0 ||
    unitPriceIndex >= 0 ||
    totalPriceIndex >= 0;

  if (!hasStructuredColumns) {
    return null;
  }

  const itemName = itemNameIndex >= 0 ? cells[itemNameIndex] || null : null;
  const quantity = quantityIndex >= 0 ? parseNumber(cells[quantityIndex]) : null;
  const unit = unitIndex >= 0 ? cells[unitIndex] || null : null;
  const unitPrice =
    unitPriceIndex >= 0 ? parseNumber(cells[unitPriceIndex]) : null;
  const totalPrice =
    totalPriceIndex >= 0 ? parseNumber(cells[totalPriceIndex]) : null;
  const vat =
    (vatIndex >= 0 ? normalizeVatValue(cells[vatIndex]) : null) ||
    normalizeVatValue(headers.join(' ')) ||
    detectVat(cells);

  if (!itemName && !quantity && !unit && isSummaryRow(cells)) {
    return null;
  }

  return {
    itemName,
    quantity,
    unit,
    unitPrice,
    totalPrice,
    vat,
    currency: detectCurrency(cells),
  };
}

export function buildExtractedPriceLines(
  headers: string[],
  rows: string[][],
): ExtractedPriceLine[] {
  return rows.map((cells, rowIndex) => ({
    rowIndex,
    cells,
    normalized: buildNormalizedPriceLine(headers, cells),
  }));
}
