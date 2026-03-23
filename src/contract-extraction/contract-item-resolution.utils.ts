import {
  ContractExtractionResult,
  ResolvedContractItem,
} from './contract-extraction.types';

type RawContractItem = Record<string, any>;

interface ExtractedLineCandidate {
  itemName: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  currency: string | null;
  documentTitle: string | null;
  documentUrl: string | null;
  page: number | null;
  rowIndex: number | null;
  confidence: number | null;
}

interface ScoredMatch {
  itemIndex: number;
  candidateIndex: number;
  score: number;
  confidence: number;
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

export function resolveContractItems(
  items: RawContractItem[],
  extractionResult: ContractExtractionResult | null,
  fallbackCurrency?: string | null,
): ResolvedContractItem[] {
  const safeItems = Array.isArray(items) ? items : [];
  const candidates = flattenExtractedLineCandidates(extractionResult);
  const scoredMatches = buildScoredMatches(safeItems, candidates);
  const assignedMatches = assignBestMatches(scoredMatches);

  return safeItems.map((item, index) => {
    const assignedMatch = assignedMatches.get(index);
    const candidateIndex = assignedMatch?.candidateIndex;
    const matchedCandidate =
      typeof candidateIndex === 'number' ? candidates[candidateIndex] : null;

    return resolveSingleContractItem(
      item,
      matchedCandidate,
      fallbackCurrency,
      assignedMatch?.confidence ?? null,
    );
  });
}

function resolveSingleContractItem(
  item: RawContractItem,
  candidate: ExtractedLineCandidate | null,
  fallbackCurrency?: string | null,
  matchConfidence?: number | null,
): ResolvedContractItem {
  const apiDescription =
    getStringValue(item?.description) ??
    getStringValue(item?.classification?.description) ??
    null;
  const documentDescription = getStringValue(candidate?.itemName) ?? null;
  const apiQuantity = getNumericValue(item?.quantity);
  const documentQuantity = getNumericValue(candidate?.quantity);
  const quantity = apiQuantity ?? documentQuantity ?? null;
  const apiUnit =
    getStringValue(item?.unit?.name) ??
    getStringValue(item?.unit?.code) ??
    null;
  const documentUnit = getStringValue(candidate?.unit) ?? null;
  const unit = apiUnit ?? documentUnit ?? null;
  const currency =
    getStringValue(item?.unit?.value?.currency) ??
    getStringValue(candidate?.currency) ??
    getStringValue(fallbackCurrency) ??
    null;
  const apiUnitPrice = getNumericValue(item?.unit?.value?.amount);
  const apiTotalPrice =
    apiUnitPrice !== null && quantity !== null ? roundMoney(quantity * apiUnitPrice) : null;
  const documentUnitPrice = getNumericValue(candidate?.unitPrice);
  const documentTotalPrice = getNumericValue(candidate?.totalPrice);

  let resolvedUnitPrice = apiUnitPrice;
  let resolvedTotalPrice = apiTotalPrice;
  let priceSource: ResolvedContractItem['priceSource'] = apiUnitPrice !== null ? 'api' : 'missing';

  if (apiUnitPrice === null) {
    if (documentUnitPrice !== null) {
      resolvedUnitPrice = documentUnitPrice;
      resolvedTotalPrice =
        documentTotalPrice !== null
          ? documentTotalPrice
          : quantity !== null
            ? roundMoney(quantity * documentUnitPrice)
            : null;
      priceSource = 'document';
    } else if (
      documentTotalPrice !== null &&
      quantity !== null &&
      quantity > 0
    ) {
      resolvedUnitPrice = roundMoney(documentTotalPrice / quantity);
      resolvedTotalPrice = documentTotalPrice;
      priceSource = 'document-derived';
    }
  } else if (
    documentUnitPrice !== null &&
    !areNumbersClose(apiUnitPrice, documentUnitPrice)
  ) {
    priceSource = 'conflict';
  } else if (
    documentTotalPrice !== null &&
    apiTotalPrice !== null &&
    !areNumbersClose(apiTotalPrice, documentTotalPrice)
  ) {
    priceSource = 'conflict';
  }

  return {
    description: apiDescription ?? documentDescription,
    quantity,
    unit,
    currency,
    classification: item?.classification
      ? {
          id: getStringValue(item?.classification?.id) ?? null,
          description: getStringValue(item?.classification?.description) ?? null,
        }
      : null,
    apiDescription,
    apiQuantity,
    apiUnit,
    apiUnitPrice,
    apiTotalPrice,
    documentDescription,
    documentQuantity,
    documentUnit,
    documentUnitPrice,
    documentTotalPrice,
    resolvedUnitPrice,
    resolvedTotalPrice,
    priceSource,
    matchConfidence: matchConfidence ?? null,
    matchedDocument: candidate
      ? {
          documentTitle: candidate.documentTitle,
          documentUrl: candidate.documentUrl,
          page: candidate.page,
          rowIndex: candidate.rowIndex,
          confidence: candidate.confidence,
        }
      : null,
  };
}

function flattenExtractedLineCandidates(
  extractionResult: ContractExtractionResult | null,
): ExtractedLineCandidate[] {
  if (!extractionResult || !Array.isArray(extractionResult.documents)) {
    return [];
  }

  const candidates: ExtractedLineCandidate[] = [];

  extractionResult.documents.forEach((document, documentIndex) => {
    if (!Array.isArray(document.tables)) {
      return;
    }

    document.tables.forEach((table, tableIndex) => {
      if (!Array.isArray(table.lines)) {
        return;
      }

      table.lines.forEach((line, lineIndex) => {
        const normalized = line.normalized;

        if (
          !normalized ||
          (normalized.unitPrice === null &&
            normalized.totalPrice === null &&
            !normalized.itemName)
        ) {
          return;
        }

        candidates.push({
          itemName: getStringValue(normalized.itemName) ?? null,
          quantity: getNumericValue(normalized.quantity),
          unit: getStringValue(normalized.unit) ?? null,
          unitPrice: getNumericValue(normalized.unitPrice),
          totalPrice: getNumericValue(normalized.totalPrice),
          currency: getStringValue(normalized.currency) ?? null,
          documentTitle: getStringValue(document.title) ?? null,
          documentUrl: getStringValue(document.url) ?? null,
          page: getNumericValue(table.page),
          rowIndex: getNumericValue(line.rowIndex),
          confidence: normalizeConfidence(table.confidence, line.normalized?.itemName),
        });
      });
    });
  });

  return candidates;
}

function buildScoredMatches(
  items: RawContractItem[],
  candidates: ExtractedLineCandidate[],
): ScoredMatch[] {
  const matches: ScoredMatch[] = [];

  items.forEach((item, itemIndex) => {
    candidates.forEach((candidate, candidateIndex) => {
      const score = scoreItemAgainstCandidate(item, candidate);

      if (score === null) {
        return;
      }

      matches.push({
        itemIndex,
        candidateIndex,
        score,
        confidence: matchScoreToConfidence(score),
      });
    });
  });

  return matches.sort((left, right) => right.score - left.score);
}

function assignBestMatches(matches: ScoredMatch[]): Map<number, ScoredMatch> {
  const assignments = new Map<number, ScoredMatch>();
  const claimedCandidates = new Set<number>();

  matches.forEach((match) => {
    if (assignments.has(match.itemIndex) || claimedCandidates.has(match.candidateIndex)) {
      return;
    }

    assignments.set(match.itemIndex, match);
    claimedCandidates.add(match.candidateIndex);
  });

  return assignments;
}

function scoreItemAgainstCandidate(
  item: RawContractItem,
  candidate: ExtractedLineCandidate,
): number | null {
  const itemTitle = normalizeText(
    getStringValue(item?.description) ??
      getStringValue(item?.classification?.description) ??
      '',
  );
  const candidateTitle = normalizeText(candidate.itemName ?? '');
  const itemQuantity = getNumericValue(item?.quantity);
  const candidateQuantity = getNumericValue(candidate.quantity);
  const itemUnit = normalizeUnit(
    getStringValue(item?.unit?.name) ?? getStringValue(item?.unit?.code) ?? '',
  );
  const candidateUnit = normalizeUnit(candidate.unit ?? '');
  const itemApiUnitPrice = getNumericValue(item?.unit?.value?.amount);
  const itemApiTotalPrice =
    itemApiUnitPrice !== null && itemQuantity !== null
      ? roundMoney(itemApiUnitPrice * itemQuantity)
      : null;

  let score = 0;
  const titleSimilarity = computeTextSimilarity(itemTitle, candidateTitle);
  const keywordOverlap = computeKeywordOverlap(itemTitle, candidateTitle);
  const phraseOverlap = hasPhraseOverlap(itemTitle, candidateTitle);
  const quantityMatches =
    itemQuantity !== null &&
    candidateQuantity !== null &&
    areNumbersClose(itemQuantity, candidateQuantity, 0.02);
  const unitMatches =
    Boolean(itemUnit) && Boolean(candidateUnit) && itemUnit === candidateUnit;

  if (itemTitle && candidateTitle) {
    score += titleSimilarity * 7;
    score += keywordOverlap * 5;

    if (titleSimilarity >= 0.92) {
      score += 2;
    } else if (titleSimilarity < 0.2) {
      score -= 2;
    }

    if (phraseOverlap) {
      score += 1.5;
    }
  }

  if (itemQuantity !== null && candidateQuantity !== null) {
    if (quantityMatches) {
      score += 4;
    } else if (areNumbersClose(itemQuantity, candidateQuantity, 0.08)) {
      score += 1.5;
    } else {
      score -= 2;
    }
  }

  if (itemUnit && candidateUnit) {
    score += unitMatches ? 2 : -1;
  }

  if (
    itemApiUnitPrice !== null &&
    candidate.unitPrice !== null &&
    areNumbersClose(itemApiUnitPrice, candidate.unitPrice)
  ) {
    score += 1.5;
  }

  if (
    itemApiTotalPrice !== null &&
    candidate.totalPrice !== null &&
    areNumbersClose(itemApiTotalPrice, candidate.totalPrice)
  ) {
    score += 1.5;
  }

  const strongSignal =
    keywordOverlap >= 0.45 ||
    titleSimilarity >= 0.45 ||
    (!itemTitle && quantityMatches && unitMatches) ||
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

  const intersectionSize = [...leftTokens].filter((token) => rightTokens.has(token)).length;
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

function hasPhraseOverlap(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }

  const leftPhrases = buildImportantPhrases(left);
  const rightPhrases = buildImportantPhrases(right);

  return leftPhrases.some((phrase) => right.includes(phrase)) ||
    rightPhrases.some((phrase) => left.includes(phrase));
}

function buildImportantPhrases(value: string): string[] {
  const tokens = getMeaningfulTokens(value);

  if (tokens.length < 2) {
    return [];
  }

  const phrases: string[] = [];

  for (let index = 0; index < tokens.length - 1; index += 1) {
    phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
  }

  return phrases;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’`"]/g, '')
    .replace(/[^a-zа-яіїєґ0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMeaningfulTokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 2 && !TITLE_STOP_WORDS.has(token));
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

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function matchScoreToConfidence(score: number): number {
  return Math.max(0, Math.min(1, score / 12));
}

function normalizeConfidence(
  tableConfidence: number | null,
  itemName: string | null | undefined,
): number | null {
  if (typeof tableConfidence !== 'number') {
    return itemName ? 0.55 : null;
  }

  return Math.max(0.35, Math.min(1, tableConfidence));
}

function getStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getNumericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
