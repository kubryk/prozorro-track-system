import {
  CONTRACT_PRICE_KEYWORDS,
  PRICE_HEADER_ALIASES,
  SPECIFICATION_TITLE_HINTS,
} from './contract-extraction.constants';
import {
  ContractDocumentCandidate,
  ExtractedPriceTable,
  ExtractedPriceLine,
  NormalizedPriceLine,
} from './contract-extraction.types';

interface ColumnStats {
  index: number;
  nonEmptyCount: number;
  numericCount: number;
  integerLikeCount: number;
  textCount: number;
  shortTextCount: number;
  averageNumeric: number | null;
}

interface ResolvedColumns {
  itemNameIndex: number;
  quantityIndex: number;
  unitIndex: number;
  unitPriceIndex: number;
  totalPriceIndex: number;
  vatIndex: number;
}

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

function getMatchedSpecificationHints(searchableText: string): string[] {
  return SPECIFICATION_TITLE_HINTS.filter((hint) => searchableText.includes(hint));
}

function getMatchedPriceKeywords(searchableText: string): string[] {
  return CONTRACT_PRICE_KEYWORDS.filter((keyword) => searchableText.includes(keyword));
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
  const normalizedTitle = normalizeText(title);

  if (!canProcessMimeType(mimeType)) {
    return null;
  }

  const searchableText = normalizeText(
    [title, description, documentType, format].filter(Boolean).join(' '),
  );
  const matchedSpecificationHints = getMatchedSpecificationHints(searchableText);
  const matchedPriceKeywords = getMatchedPriceKeywords(searchableText);
  const matchedKeywords = [...new Set([
    ...matchedSpecificationHints,
    ...matchedPriceKeywords,
  ])];

  let relevanceScore = 1;

  if (mimeType === 'application/pdf') {
    relevanceScore += 1;
  }

  if (matchedPriceKeywords.length > 0) {
    relevanceScore += matchedPriceKeywords.length * 2;
  }

  if (matchedSpecificationHints.length > 0) {
    relevanceScore += matchedSpecificationHints.length * 3;
  }

  if (SPECIFICATION_TITLE_HINTS.some((hint) => normalizedTitle.includes(hint))) {
    relevanceScore += 4;
  }

  if (SPECIFICATION_TITLE_HINTS.some((hint) => normalizedTitle.startsWith(hint))) {
    relevanceScore += 2;
  }

  if (normalizeText(documentType).includes('technicalSpecifications')) {
    relevanceScore += 3;
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

function cleanCellValue(value: string | null | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function detectCurrency(values: string[]): string | null {
  const joined = normalizeText(values.join(' '));

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

function isEmptyCell(value: string | null | undefined): boolean {
  return normalizeText(value) === '';
}

function isNumericLike(value: string | null | undefined): boolean {
  return parseNumber(value) !== null;
}

function isIntegerLikeValue(value: string | null | undefined): boolean {
  const parsed = parseNumber(value);

  if (parsed === null) {
    return false;
  }

  return Math.abs(parsed - Math.round(parsed)) < 0.000001;
}

function isUnitLikeValue(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);

  if (!normalized || isNumericLike(normalized)) {
    return false;
  }

  return (
    normalized.length <= 12 &&
    /[a-zа-яіїєґ]/i.test(normalized) &&
    !normalized.includes('наймен') &&
    !normalized.includes('послуг') &&
    !normalized.includes('товар')
  );
}

function getColumnStats(rows: string[][], index: number): ColumnStats {
  const values = rows.map((row) => row[index] || '').filter((value) => !isEmptyCell(value));
  const numericValues = values
    .map((value) => parseNumber(value))
    .filter((value): value is number => value !== null);

  return {
    index,
    nonEmptyCount: values.length,
    numericCount: numericValues.length,
    integerLikeCount: values.filter((value) => isIntegerLikeValue(value)).length,
    textCount: values.filter((value) => !isNumericLike(value)).length,
    shortTextCount: values.filter((value) => isUnitLikeValue(value)).length,
    averageNumeric:
      numericValues.length > 0
        ? numericValues.reduce((sum, value) => sum + value, 0) /
          numericValues.length
        : null,
  };
}

function findFirstTextColumn(rows: string[][]): number {
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const stats = Array.from({ length: maxColumns }, (_, index) =>
    getColumnStats(rows, index),
  );

  const ranked = stats
    .map((stat) => ({
      index: stat.index,
      score:
        stat.textCount * 3 +
        stat.shortTextCount * -2 +
        stat.numericCount * -2 +
        stat.nonEmptyCount,
    }))
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.score > 0 ? ranked[0].index : -1;
}

function findLikelyUnitColumn(rows: string[][], quantityIndex: number): number {
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const stats = Array.from({ length: maxColumns }, (_, index) =>
    getColumnStats(rows, index),
  );
  const candidates = stats
    .filter(
      (stat) =>
        stat.index !== quantityIndex &&
        stat.shortTextCount > 0 &&
        stat.numericCount < stat.nonEmptyCount,
    )
    .map((stat) => ({
      index: stat.index,
      score:
        stat.shortTextCount * 3 +
        stat.textCount -
        Math.abs(stat.index - quantityIndex),
    }))
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.score > 0 ? candidates[0].index : -1;
}

function findLikelyQuantityColumn(
  rows: string[][],
  excludedIndexes: Set<number>,
): number {
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const stats = Array.from({ length: maxColumns }, (_, index) =>
    getColumnStats(rows, index),
  );
  const candidates = stats
    .filter(
      (stat) =>
        !excludedIndexes.has(stat.index) &&
        stat.numericCount > 0 &&
        stat.nonEmptyCount > 0,
    )
    .map((stat) => ({
      index: stat.index,
      score:
        stat.integerLikeCount * 3 +
        stat.numericCount * 2 -
        (stat.averageNumeric && stat.averageNumeric > 100000 ? 10 : 0) -
        stat.index,
    }))
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.score > 0 ? candidates[0].index : -1;
}

function inferPriceColumns(
  rows: string[][],
  quantityIndex: number,
  excludedIndexes: Set<number>,
): { unitPriceIndex: number; totalPriceIndex: number } {
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const stats = Array.from({ length: maxColumns }, (_, index) =>
    getColumnStats(rows, index),
  );
  const numericCandidates = stats.filter(
    (stat) =>
      !excludedIndexes.has(stat.index) &&
      stat.numericCount > 0 &&
      stat.averageNumeric !== null,
  );

  if (numericCandidates.length === 0) {
    return {
      unitPriceIndex: -1,
      totalPriceIndex: -1,
    };
  }

  const rightmostNumeric = [...numericCandidates].sort(
    (left, right) => right.index - left.index,
  )[0];

  let totalPriceIndex = rightmostNumeric?.index ?? -1;
  let unitPriceIndex = -1;

  const otherNumericColumns = numericCandidates.filter(
    (candidate) => candidate.index !== totalPriceIndex,
  );

  const multiplicationCandidates = otherNumericColumns
    .map((candidate) => {
      let matchCount = 0;

      for (const row of rows) {
        const quantity = quantityIndex >= 0 ? parseNumber(row[quantityIndex]) : null;
        const unitPrice = parseNumber(row[candidate.index]);
        const totalPrice =
          totalPriceIndex >= 0 ? parseNumber(row[totalPriceIndex]) : null;

        if (
          quantity !== null &&
          unitPrice !== null &&
          totalPrice !== null &&
          Math.abs(quantity * unitPrice - totalPrice) <=
            Math.max(1, totalPrice * 0.02)
        ) {
          matchCount += 1;
        }
      }

      return {
        index: candidate.index,
        score:
          matchCount * 5 +
          (candidate.averageNumeric !== null &&
          rightmostNumeric?.averageNumeric !== null &&
          candidate.averageNumeric < rightmostNumeric.averageNumeric
            ? 2
            : 0) -
          Math.abs(candidate.index - totalPriceIndex),
      };
    })
    .sort((left, right) => right.score - left.score);

  if (multiplicationCandidates[0]?.score > 0) {
    unitPriceIndex = multiplicationCandidates[0].index;
  }

  if (unitPriceIndex < 0 && otherNumericColumns.length > 0) {
    unitPriceIndex = [...otherNumericColumns].sort(
      (left, right) =>
        (left.averageNumeric ?? Number.MAX_SAFE_INTEGER) -
        (right.averageNumeric ?? Number.MAX_SAFE_INTEGER),
    )[0].index;
  }

  if (unitPriceIndex >= 0 && totalPriceIndex >= 0) {
    return { unitPriceIndex, totalPriceIndex };
  }

  if (unitPriceIndex < 0 && totalPriceIndex >= 0 && quantityIndex >= 0) {
    unitPriceIndex = totalPriceIndex;
    totalPriceIndex = -1;
  }

  return { unitPriceIndex, totalPriceIndex };
}

function resolveColumns(headers: string[], rows: string[][]): ResolvedColumns {
  const itemNameIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.itemName);
  const quantityIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.quantity);
  const unitIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.unit);
  const unitPriceIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.unitPrice);
  const totalPriceIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.totalPrice);
  const vatIndex = findHeaderIndex(headers, PRICE_HEADER_ALIASES.vat);

  const resolved: ResolvedColumns = {
    itemNameIndex,
    quantityIndex,
    unitIndex,
    unitPriceIndex,
    totalPriceIndex,
    vatIndex,
  };

  const excludedIndexes = new Set<number>(
    [
      resolved.itemNameIndex,
      resolved.quantityIndex,
      resolved.unitIndex,
      resolved.unitPriceIndex,
      resolved.totalPriceIndex,
    ].filter((index) => index >= 0),
  );

  if (resolved.itemNameIndex < 0) {
    resolved.itemNameIndex = findFirstTextColumn(rows);

    if (resolved.itemNameIndex >= 0) {
      excludedIndexes.add(resolved.itemNameIndex);
    }
  }

  if (resolved.quantityIndex < 0) {
    resolved.quantityIndex = findLikelyQuantityColumn(rows, excludedIndexes);

    if (resolved.quantityIndex >= 0) {
      excludedIndexes.add(resolved.quantityIndex);
    }
  }

  if (resolved.unitIndex < 0 && resolved.quantityIndex >= 0) {
    resolved.unitIndex = findLikelyUnitColumn(rows, resolved.quantityIndex);

    if (resolved.unitIndex >= 0) {
      excludedIndexes.add(resolved.unitIndex);
    }
  }

  if (resolved.unitPriceIndex < 0 || resolved.totalPriceIndex < 0) {
    const inferredPrices = inferPriceColumns(
      rows,
      resolved.quantityIndex,
      excludedIndexes,
    );

    if (resolved.unitPriceIndex < 0) {
      resolved.unitPriceIndex = inferredPrices.unitPriceIndex;
    }

    if (resolved.totalPriceIndex < 0) {
      resolved.totalPriceIndex = inferredPrices.totalPriceIndex;
    }
  }

  return resolved;
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
  resolvedColumns: ResolvedColumns,
): NormalizedPriceLine | null {
  const hasStructuredColumns =
    resolvedColumns.itemNameIndex >= 0 ||
    resolvedColumns.quantityIndex >= 0 ||
    resolvedColumns.unitPriceIndex >= 0 ||
    resolvedColumns.totalPriceIndex >= 0;

  if (!hasStructuredColumns) {
    return null;
  }

  const itemName =
    resolvedColumns.itemNameIndex >= 0
      ? cells[resolvedColumns.itemNameIndex] || null
      : null;
  const quantity =
    resolvedColumns.quantityIndex >= 0
      ? parseNumber(cells[resolvedColumns.quantityIndex])
      : null;
  const unit =
    resolvedColumns.unitIndex >= 0 ? cells[resolvedColumns.unitIndex] || null : null;
  const unitPrice =
    resolvedColumns.unitPriceIndex >= 0
      ? parseNumber(cells[resolvedColumns.unitPriceIndex])
      : null;
  const totalPrice =
    resolvedColumns.totalPriceIndex >= 0
      ? parseNumber(cells[resolvedColumns.totalPriceIndex])
      : null;
  const vat =
    (resolvedColumns.vatIndex >= 0
      ? normalizeVatValue(cells[resolvedColumns.vatIndex])
      : null) ||
    normalizeVatValue(headers.join(' ')) ||
    detectVat(cells);

  if (
    isSummaryRow(cells) ||
    cells.every((cell) => isEmptyCell(cell)) ||
    (!itemName && quantity === null && unitPrice === null && totalPrice === null)
  ) {
    return null;
  }

  return {
    itemName,
    quantity,
    unit,
    unitPrice,
    totalPrice,
    vat,
    currency: detectCurrency([...headers, ...cells]),
  };
}

export function buildExtractedPriceLines(
  headers: string[],
  rows: string[][],
): ExtractedPriceLine[] {
  const resolvedColumns = resolveColumns(headers, rows);

  return rows.map((cells, rowIndex) => ({
    rowIndex,
    cells,
    normalized: buildNormalizedPriceLine(headers, cells, resolvedColumns),
  }));
}

export function isUsableExtractedText(text: string | null | undefined): boolean {
  const normalized = cleanCellValue(text);

  if (normalized.length < 80) {
    return false;
  }

  const letters = normalized.match(/\p{L}/gu) ?? [];
  const digits = normalized.match(/\p{N}/gu) ?? [];
  const signalLength = letters.length + digits.length;

  return letters.length >= 20 && signalLength / normalized.length >= 0.35;
}

export function hasPriceExtractionSignal(
  text: string | null | undefined,
  tables: ExtractedPriceTable[] | null | undefined,
): boolean {
  const safeTables = Array.isArray(tables) ? tables : [];
  const hasStructuredTableLine = safeTables.some((table) =>
    Array.isArray(table?.lines)
      ? table.lines.some((line) => line?.normalized)
      : false,
  );

  if (hasStructuredTableLine) {
    return true;
  }

  const normalizedText = normalizeText(text);

  if (!normalizedText) {
    return false;
  }

  const hasSpecificationHint = SPECIFICATION_TITLE_HINTS.some((hint) =>
    normalizedText.includes(hint),
  );
  const hasItemHeader = PRICE_HEADER_ALIASES.itemName.some((alias) =>
    normalizedText.includes(alias),
  );
  const hasQuantityHeader = PRICE_HEADER_ALIASES.quantity.some((alias) =>
    normalizedText.includes(alias),
  );
  const hasUnitHeader = PRICE_HEADER_ALIASES.unit.some((alias) =>
    normalizedText.includes(alias),
  );
  const hasUnitPriceHeader = PRICE_HEADER_ALIASES.unitPrice.some((alias) =>
    normalizedText.includes(alias),
  );
  const hasTotalPriceHeader = PRICE_HEADER_ALIASES.totalPrice.some((alias) =>
    normalizedText.includes(alias),
  );
  const hasGridSignals =
    hasItemHeader &&
    hasQuantityHeader &&
    (hasUnitHeader || hasUnitPriceHeader || hasTotalPriceHeader);

  return hasGridSignals || (hasSpecificationHint && hasQuantityHeader && hasUnitPriceHeader);
}

export function extractTextAfterSpecification(
  text: string | null | undefined,
): string | null {
  if (typeof text !== 'string') {
    return null;
  }

  const normalizedText = text.trim();

  if (!normalizedText) {
    return null;
  }

  const specificationMatch = /специфікація|specification/i.exec(normalizedText);

  if (!specificationMatch || specificationMatch.index < 0) {
    return normalizedText;
  }

  const sliceStart = specificationMatch.index + specificationMatch[0].length;
  const relevantText = normalizedText
    .slice(sliceStart)
    .replace(/^[\s:;,\-.–—]+/u, '')
    .trim();

  return relevantText || normalizedText;
}

export function parseMarkdownTables(markdown: string): string[][][] {
  const lines = String(markdown || '').split(/\r?\n/);
  const tables: string[][][] = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const currentLine = lines[index];
    const separatorLine = lines[index + 1];

    if (!currentLine.includes('|') || !isMarkdownSeparatorLine(separatorLine)) {
      continue;
    }

    const block: string[] = [currentLine, separatorLine];
    let cursor = index + 2;

    while (cursor < lines.length && lines[cursor].includes('|')) {
      block.push(lines[cursor]);
      cursor += 1;
    }

    index = cursor - 1;

    const rows = block
      .filter((line, rowIndex) => rowIndex !== 1)
      .map(parseMarkdownTableRow)
      .filter((row) => row.some((cell) => cleanCellValue(cell) !== ''));

    if (rows.length >= 2) {
      tables.push(rows);
    }
  }

  return tables;
}

export function buildExtractedPriceTablesFromArrays(
  page: number,
  rawTables: string[][][],
  confidence: number | null = null,
): ExtractedPriceTable[] {
  return rawTables
    .map((tableRows) => sanitizeTableRows(tableRows))
    .filter((tableRows) => tableRows.length >= 2)
    .map((tableRows) => {
      const [headers, ...rows] = tableRows;

      return {
        page,
        headers,
        confidence,
        lines: buildExtractedPriceLines(headers, rows),
      };
    });
}

function sanitizeTableRows(rows: string[][]): string[][] {
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);

  return rows
    .map((row) =>
      Array.from({ length: maxColumns }, (_, index) => cleanCellValue(row[index])),
    )
    .filter((row) => row.some((cell) => cell !== ''));
}

function isMarkdownSeparatorLine(value: string): boolean {
  const normalized = cleanCellValue(value);

  if (!normalized.includes('-')) {
    return false;
  }

  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(normalized);
}

function parseMarkdownTableRow(line: string): string[] {
  const normalized = cleanCellValue(line)
    .replace(/^\|/, '')
    .replace(/\|$/, '');

  return normalized.split('|').map((cell) => cleanCellValue(cell));
}
