import {
  ContractUsageMetric,
  ContractUsageSummary,
} from './contract-extraction.types';

const DEFAULT_GEMINI_INPUT_COST_PER_1M_USD = 0.1;
const DEFAULT_GEMINI_OUTPUT_COST_PER_1M_USD = 0.4;
const DEFAULT_MISTRAL_OCR_COST_PER_PAGE_USD = 0.002;
const DEFAULT_GROUNDED_SEARCH_COST_PER_REQUEST_USD = 0;

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getEnvNumber(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] || '');

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function buildPdfTextUsageMetric(pageCount: number | null): ContractUsageMetric {
  return {
    stage: 'pdf-text',
    provider: 'local',
    model: 'pdf-parse',
    requestCount: 1,
    promptTokens: null,
    outputTokens: null,
    totalTokens: null,
    processedPages: pageCount,
    groundedSearchRequests: null,
    estimatedInputCostUsd: 0,
    estimatedOutputCostUsd: 0,
    estimatedGroundingCostUsd: 0,
    estimatedCostUsd: 0,
    currency: 'USD',
  };
}

export function buildMistralOcrUsageMetric(args: {
  pageCount: number | null;
  model: string | null;
}): ContractUsageMetric {
  const costPerPage = getEnvNumber(
    'MISTRAL_OCR_COST_PER_PAGE_USD',
    DEFAULT_MISTRAL_OCR_COST_PER_PAGE_USD,
  );
  const pages = args.pageCount ?? 0;
  const estimatedCostUsd = roundCurrency(pages * costPerPage);

  return {
    stage: 'mistral-ocr',
    provider: 'mistral',
    model: args.model,
    requestCount: 1,
    promptTokens: null,
    outputTokens: null,
    totalTokens: null,
    processedPages: args.pageCount,
    groundedSearchRequests: null,
    estimatedInputCostUsd: null,
    estimatedOutputCostUsd: null,
    estimatedGroundingCostUsd: 0,
    estimatedCostUsd,
    currency: 'USD',
  };
}

export function buildGeminiUsageMetric(args: {
  stage: ContractUsageMetric['stage'];
  model: string | null;
  response: Record<string, unknown> | null;
  groundedSearchRequests?: number;
}): ContractUsageMetric | null {
  const usageMetadata =
    args.response &&
    typeof args.response === 'object' &&
    args.response.usageMetadata &&
    typeof args.response.usageMetadata === 'object'
      ? (args.response.usageMetadata as Record<string, unknown>)
      : null;

  if (!usageMetadata) {
    return null;
  }

  const promptTokens =
    toNumber(usageMetadata.promptTokenCount) ??
    toNumber(usageMetadata.inputTokenCount);
  const outputTokens =
    toNumber(usageMetadata.candidatesTokenCount) ??
    toNumber(usageMetadata.outputTokenCount) ??
    toNumber(usageMetadata.candidateTokenCount);
  const totalTokens =
    toNumber(usageMetadata.totalTokenCount) ??
    ((promptTokens ?? 0) + (outputTokens ?? 0));
  const groundedSearchRequests = args.groundedSearchRequests ?? 0;
  const inputRate = getEnvNumber(
    'GEMINI_TOKEN_INPUT_COST_PER_1M_USD',
    DEFAULT_GEMINI_INPUT_COST_PER_1M_USD,
  );
  const outputRate = getEnvNumber(
    'GEMINI_TOKEN_OUTPUT_COST_PER_1M_USD',
    DEFAULT_GEMINI_OUTPUT_COST_PER_1M_USD,
  );
  const groundedRate = getEnvNumber(
    'GEMINI_GROUNDED_SEARCH_COST_PER_REQUEST_USD',
    DEFAULT_GROUNDED_SEARCH_COST_PER_REQUEST_USD,
  );
  const estimatedInputCostUsd =
    promptTokens === null ? null : roundCurrency((promptTokens / 1_000_000) * inputRate);
  const estimatedOutputCostUsd =
    outputTokens === null ? null : roundCurrency((outputTokens / 1_000_000) * outputRate);
  const estimatedGroundingCostUsd = roundCurrency(groundedSearchRequests * groundedRate);
  const estimatedCostUsd = roundCurrency(
    (estimatedInputCostUsd ?? 0) +
      (estimatedOutputCostUsd ?? 0) +
      estimatedGroundingCostUsd,
  );

  return {
    stage: args.stage,
    provider: 'gemini',
    model: args.model,
    requestCount: 1,
    promptTokens,
    outputTokens,
    totalTokens,
    processedPages: null,
    groundedSearchRequests: groundedSearchRequests || null,
    estimatedInputCostUsd,
    estimatedOutputCostUsd,
    estimatedGroundingCostUsd,
    estimatedCostUsd,
    currency: 'USD',
  };
}

export function summarizeUsageMetrics(
  metrics: Array<ContractUsageMetric | null | undefined>,
): ContractUsageSummary | null {
  const normalized = metrics.filter(
    (metric): metric is ContractUsageMetric => Boolean(metric),
  );

  if (!normalized.length) {
    return null;
  }

  return {
    totalEstimatedCostUsd: roundCurrency(
      normalized.reduce(
        (sum, metric) => sum + (metric.estimatedCostUsd ?? 0),
        0,
      ),
    ),
    totalPromptTokens: normalized.reduce(
      (sum, metric) => sum + (metric.promptTokens ?? 0),
      0,
    ),
    totalOutputTokens: normalized.reduce(
      (sum, metric) => sum + (metric.outputTokens ?? 0),
      0,
    ),
    totalTokens: normalized.reduce(
      (sum, metric) => sum + (metric.totalTokens ?? 0),
      0,
    ),
    totalProcessedPages: normalized.reduce(
      (sum, metric) => sum + (metric.processedPages ?? 0),
      0,
    ),
    totalGroundedSearchRequests: normalized.reduce(
      (sum, metric) => sum + (metric.groundedSearchRequests ?? 0),
      0,
    ),
    breakdown: normalized,
  };
}

export function mergeUsageSummaries(
  summaries: Array<ContractUsageSummary | null | undefined>,
): ContractUsageSummary | null {
  return summarizeUsageMetrics(
    summaries.flatMap((summary) => summary?.breakdown ?? []),
  );
}

export function parseStoredUsageMetric(value: unknown): ContractUsageMetric | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const metric = value as Record<string, unknown>;

  if (
    metric.stage !== 'pdf-text' &&
    metric.stage !== 'mistral-ocr' &&
    metric.stage !== 'gemini-extraction' &&
    metric.stage !== 'gemini-audit-grounded' &&
    metric.stage !== 'gemini-audit-structured' &&
    metric.stage !== 'gemini-audit-final'
  ) {
    return null;
  }

  if (
    metric.provider !== 'local' &&
    metric.provider !== 'mistral' &&
    metric.provider !== 'gemini'
  ) {
    return null;
  }

  return {
    stage: metric.stage,
    provider: metric.provider,
    model: typeof metric.model === 'string' ? metric.model : null,
    requestCount: toNumber(metric.requestCount) ?? 0,
    promptTokens: toNumber(metric.promptTokens),
    outputTokens: toNumber(metric.outputTokens),
    totalTokens: toNumber(metric.totalTokens),
    processedPages: toNumber(metric.processedPages),
    groundedSearchRequests: toNumber(metric.groundedSearchRequests),
    estimatedInputCostUsd: toNumber(metric.estimatedInputCostUsd),
    estimatedOutputCostUsd: toNumber(metric.estimatedOutputCostUsd),
    estimatedGroundingCostUsd: toNumber(metric.estimatedGroundingCostUsd),
    estimatedCostUsd: toNumber(metric.estimatedCostUsd),
    currency: 'USD',
  };
}

export function parseStoredUsageSummary(value: unknown): ContractUsageSummary | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const summary = value as Record<string, unknown>;
  const breakdown = Array.isArray(summary.breakdown)
    ? summary.breakdown
        .map((metric) => parseStoredUsageMetric(metric))
        .filter((metric): metric is ContractUsageMetric => Boolean(metric))
    : [];

  if (!breakdown.length) {
    return null;
  }

  return summarizeUsageMetrics(breakdown);
}
