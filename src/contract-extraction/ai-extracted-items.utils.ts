import { AiExtractedContractItem } from './contract-extraction.types';

export function dedupeAiExtractedItems(
  items: AiExtractedContractItem[],
): AiExtractedContractItem[] {
  const deduped: AiExtractedContractItem[] = [];

  for (const item of items) {
    const duplicateIndex = deduped.findIndex((existing) =>
      areDuplicateExtractedItems(existing, item),
    );

    if (duplicateIndex === -1) {
      deduped.push(item);
      continue;
    }

    deduped[duplicateIndex] = mergeExtractedItems(deduped[duplicateIndex], item);
  }

  return deduped;
}

function areDuplicateExtractedItems(
  left: AiExtractedContractItem,
  right: AiExtractedContractItem,
): boolean {
  const leftName = normalizeText(left.itemName);
  const rightName = normalizeText(right.itemName);

  if (!leftName || !rightName || !namesLookEquivalent(leftName, rightName)) {
    return false;
  }

  const leftUnit = normalizeText(left.unit);
  const rightUnit = normalizeText(right.unit);

  if (leftUnit && rightUnit && leftUnit !== rightUnit) {
    return false;
  }

  if (
    left.quantity !== null &&
    right.quantity !== null &&
    !numbersAreClose(left.quantity, right.quantity)
  ) {
    return false;
  }

  if (
    left.unitPrice !== null &&
    right.unitPrice !== null &&
    !numbersAreClose(left.unitPrice, right.unitPrice)
  ) {
    return false;
  }

  if (
    left.totalPrice !== null &&
    right.totalPrice !== null &&
    !numbersAreClose(left.totalPrice, right.totalPrice)
  ) {
    return false;
  }

  const leftHasStructure =
    left.quantity !== null ||
    left.unit !== null ||
    left.unitPrice !== null ||
    left.totalPrice !== null;
  const rightHasStructure =
    right.quantity !== null ||
    right.unit !== null ||
    right.unitPrice !== null ||
    right.totalPrice !== null;

  if (!leftHasStructure && !rightHasStructure) {
    return leftName === rightName;
  }

  return true;
}

function mergeExtractedItems(
  left: AiExtractedContractItem,
  right: AiExtractedContractItem,
): AiExtractedContractItem {
  const preferred = getCompletenessScore(right) > getCompletenessScore(left)
    ? right
    : left;
  const fallback = preferred === left ? right : left;

  return {
    source:
      preferred.source === 'document' || fallback.source === 'document'
        ? 'document'
        : 'api-fallback',
    documentTitle: preferred.documentTitle ?? fallback.documentTitle,
    extractionMethod: preferred.extractionMethod ?? fallback.extractionMethod,
    itemName: pickRicherText(left.itemName, right.itemName) ?? left.itemName ?? right.itemName ?? '',
    quantity: preferred.quantity ?? fallback.quantity,
    unit: preferred.unit ?? fallback.unit,
    unitPrice: preferred.unitPrice ?? fallback.unitPrice,
    totalPrice: preferred.totalPrice ?? fallback.totalPrice,
    currency: preferred.currency ?? fallback.currency,
    vat: preferred.vat ?? fallback.vat,
    sourceSnippet: pickRicherText(preferred.sourceSnippet, fallback.sourceSnippet),
    confidence: pickHigherNumber(preferred.confidence, fallback.confidence),
  };
}

function getCompletenessScore(item: AiExtractedContractItem): number {
  let score = 0;

  if (item.documentTitle) score += 1;
  if (item.extractionMethod) score += 1;
  if (item.itemName) score += 2;
  if (item.quantity !== null) score += 2;
  if (item.unit) score += 1;
  if (item.unitPrice !== null) score += 3;
  if (item.totalPrice !== null) score += 2;
  if (item.currency) score += 1;
  if (item.vat) score += 1;
  if (item.sourceSnippet) score += 1;
  if (item.confidence !== null) score += item.confidence;

  return score;
}

function pickHigherNumber(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) {
    return right;
  }

  if (right === null) {
    return left;
  }

  return right > left ? right : left;
}

function pickRicherText(
  left: string | null,
  right: string | null,
): string | null {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return normalizeText(right).length > normalizeText(left).length ? right : left;
}

function namesLookEquivalent(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  if (left.includes(right) || right.includes(left)) {
    return true;
  }

  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return false;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const overlap =
    intersection / Math.max(leftTokens.size, rightTokens.size);

  return overlap >= 0.75;
}

function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[`'’"]/g, '')
    .replace(/[^a-z0-9а-яіїєґ]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function numbersAreClose(left: number, right: number): boolean {
  const delta = Math.abs(left - right);
  const tolerance = Math.max(0.01, Math.max(Math.abs(left), Math.abs(right)) * 0.01);

  return delta <= tolerance;
}
