import { AiExtractedContractItem } from './contract-extraction.types';

type RawContractItem = Record<string, any>;

interface ScoredMatch {
  apiIndex: number;
  extractedIndex: number;
  score: number;
}

const TITLE_STOP_WORDS = new Set([
  'послуги',
  'товар',
  'товари',
  'роботи',
  'робота',
  'предмет',
  'закупівлі',
  'закупівля',
  'надання',
  'виконання',
  'поставка',
  'постачання',
  'для',
  'щодо',
  'та',
  'або',
  'з',
  'із',
  'iз',
  'у',
  'в',
  'по',
]);

export function alignAiExtractedItemsToApiItems(
  apiItems: RawContractItem[],
  extractedItems: AiExtractedContractItem[],
  fallbackCurrency?: string | null,
): AiExtractedContractItem[] {
  const safeApiItems = Array.isArray(apiItems) ? apiItems : [];
  const safeExtractedItems = Array.isArray(extractedItems) ? extractedItems : [];

  if (safeApiItems.length === 0) {
    return safeExtractedItems;
  }

  const matches = buildMatches(safeApiItems, safeExtractedItems);
  const assigned = assignBestMatches(matches);

  return safeApiItems.map((apiItem, apiIndex) => {
    const extractedIndex = assigned.get(apiIndex);
    const matchedItem =
      typeof extractedIndex === 'number' ? safeExtractedItems[extractedIndex] : null;

    return mergeApiItemWithExtracted(apiItem, matchedItem, fallbackCurrency);
  });
}

function mergeApiItemWithExtracted(
  apiItem: RawContractItem,
  matchedItem: AiExtractedContractItem | null,
  fallbackCurrency?: string | null,
): AiExtractedContractItem {
  const apiName =
    getString(apiItem?.description) ??
    getString(apiItem?.classification?.description) ??
    'Без назви';
  const apiQuantity = getNumber(apiItem?.quantity);
  const apiUnit =
    getString(apiItem?.unit?.name) ?? getString(apiItem?.unit?.code) ?? null;
  const apiUnitPrice = getNumber(apiItem?.unit?.value?.amount);
  const apiCurrency =
    getString(apiItem?.unit?.value?.currency) ??
    getString(fallbackCurrency) ??
    null;
  const apiTotalPrice =
    apiQuantity !== null && apiUnitPrice !== null
      ? roundMoney(apiQuantity * apiUnitPrice)
      : null;

  return {
    source: matchedItem?.source ?? 'api-fallback',
    documentTitle: matchedItem?.documentTitle ?? null,
    extractionMethod: matchedItem?.extractionMethod ?? null,
    itemName: matchedItem?.itemName || apiName,
    quantity: matchedItem?.quantity ?? apiQuantity,
    unit: matchedItem?.unit ?? apiUnit,
    unitPrice: matchedItem?.unitPrice ?? apiUnitPrice,
    totalPrice: matchedItem?.totalPrice ?? apiTotalPrice,
    currency: matchedItem?.currency ?? apiCurrency,
    vat: matchedItem?.vat ?? null,
    sourceSnippet: matchedItem?.sourceSnippet ?? null,
    confidence: matchedItem?.confidence ?? null,
  };
}

function buildMatches(
  apiItems: RawContractItem[],
  extractedItems: AiExtractedContractItem[],
): ScoredMatch[] {
  const matches: ScoredMatch[] = [];

  apiItems.forEach((apiItem, apiIndex) => {
    extractedItems.forEach((extractedItem, extractedIndex) => {
      const score = scoreApiItemAgainstExtracted(apiItem, extractedItem);

      if (score === null) {
        return;
      }

      matches.push({
        apiIndex,
        extractedIndex,
        score,
      });
    });
  });

  return matches.sort((left, right) => right.score - left.score);
}

function assignBestMatches(matches: ScoredMatch[]): Map<number, number> {
  const assignedApi = new Map<number, number>();
  const claimedExtracted = new Set<number>();

  for (const match of matches) {
    if (assignedApi.has(match.apiIndex) || claimedExtracted.has(match.extractedIndex)) {
      continue;
    }

    assignedApi.set(match.apiIndex, match.extractedIndex);
    claimedExtracted.add(match.extractedIndex);
  }

  return assignedApi;
}

function scoreApiItemAgainstExtracted(
  apiItem: RawContractItem,
  extractedItem: AiExtractedContractItem,
): number | null {
  const apiTitle = normalizeText(
    getString(apiItem?.description) ??
      getString(apiItem?.classification?.description) ??
      '',
  );
  const extractedTitle = normalizeText(extractedItem.itemName || '');
  const apiQuantity = getNumber(apiItem?.quantity);
  const extractedQuantity = getNumber(extractedItem.quantity);
  const apiUnit = normalizeUnit(
    getString(apiItem?.unit?.name) ?? getString(apiItem?.unit?.code) ?? '',
  );
  const extractedUnit = normalizeUnit(getString(extractedItem.unit) ?? '');

  let score = 0;
  const titleSimilarity = computeTextSimilarity(apiTitle, extractedTitle);
  const keywordOverlap = computeKeywordOverlap(apiTitle, extractedTitle);
  const quantityMatches =
    apiQuantity !== null &&
    extractedQuantity !== null &&
    areNumbersClose(apiQuantity, extractedQuantity, 0.02);
  const unitMatches =
    Boolean(apiUnit) && Boolean(extractedUnit) && apiUnit === extractedUnit;

  if (apiTitle && extractedTitle) {
    score += titleSimilarity * 7;
    score += keywordOverlap * 5;

    if (titleSimilarity >= 0.92) {
      score += 2;
    } else if (titleSimilarity < 0.2) {
      score -= 2;
    }
  }

  if (apiQuantity !== null && extractedQuantity !== null) {
    if (quantityMatches) {
      score += 4;
    } else if (areNumbersClose(apiQuantity, extractedQuantity, 0.08)) {
      score += 1.5;
    } else {
      score -= 2;
    }
  }

  if (apiUnit && extractedUnit) {
    score += unitMatches ? 2 : -1;
  }

  const strongSignal =
    keywordOverlap >= 0.45 ||
    titleSimilarity >= 0.45 ||
    (!apiTitle && quantityMatches && unitMatches) ||
    (quantityMatches && unitMatches && keywordOverlap >= 0.2) ||
    (titleSimilarity >= 0.25 && quantityMatches);

  if (!strongSignal || score < 4) {
    return null;
  }

  return score;
}

function computeTextSimilarity(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  if (left.includes(right) || right.includes(left)) {
    return 0.86;
  }

  const leftTokens = new Set(getMeaningfulTokens(left));
  const rightTokens = new Set(getMeaningfulTokens(right));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  const intersectionSize = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  const unionSize = new Set([...leftTokens, ...rightTokens]).size;

  if (unionSize === 0) {
    return 0;
  }

  return intersectionSize / unionSize;
}

function computeKeywordOverlap(left: string, right: string): number {
  const leftTokens = getMeaningfulTokens(left);
  const rightTokens = new Set(getMeaningfulTokens(right));

  if (leftTokens.length === 0 || rightTokens.size === 0) {
    return 0;
  }

  const matched = leftTokens.filter((token) => rightTokens.has(token)).length;
  return matched / leftTokens.length;
}

function getMeaningfulTokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 2 && !TITLE_STOP_WORDS.has(token));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’`"]/g, '')
    .replace(/[^a-zа-яіїєґ0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUnit(value: string): string {
  const normalized = normalizeText(value).replace(/\s+/g, '');

  if (!normalized) {
    return '';
  }

  if (['квм', 'м2', 'm2'].includes(normalized)) {
    return 'm2';
  }

  if (['кубм', 'м3', 'm3'].includes(normalized)) {
    return 'm3';
  }

  if (['штука', 'шт', 'од'].includes(normalized)) {
    return 'pcs';
  }

  return normalized;
}

function areNumbersClose(
  left: number,
  right: number,
  relativeTolerance = 0.03,
): boolean {
  const delta = Math.abs(left - right);
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);

  return delta <= scale * relativeTolerance;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
