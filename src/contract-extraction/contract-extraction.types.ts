export interface ExtractionJobPayload {
  contractDbId: string;
  extractionRunId: string;
}

export interface ContractDocumentCandidate {
  title: string;
  url: string;
  mimeType: string;
  format: string | null;
  description: string | null;
  documentType: string | null;
  relevanceScore: number;
  matchedKeywords: string[];
}

export interface NormalizedPriceLine {
  itemName: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  vat: string | null;
  currency: string | null;
}

export interface ExtractedPriceLine {
  rowIndex: number;
  cells: string[];
  normalized: NormalizedPriceLine | null;
}

export interface ExtractedPriceTable {
  page: number;
  headers: string[];
  confidence: number | null;
  lines: ExtractedPriceLine[];
}

export type ContractProcessingStage =
  | 'pdf-text'
  | 'mistral-ocr'
  | 'gemini-extraction'
  | 'gemini-audit-grounded'
  | 'gemini-audit-structured'
  | 'gemini-audit-final';

export type ContractProcessingProvider = 'local' | 'mistral' | 'gemini';

export interface ContractUsageMetric {
  stage: ContractProcessingStage;
  provider: ContractProcessingProvider;
  model: string | null;
  requestCount: number;
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  processedPages: number | null;
  groundedSearchRequests: number | null;
  estimatedInputCostUsd: number | null;
  estimatedOutputCostUsd: number | null;
  estimatedGroundingCostUsd: number | null;
  estimatedCostUsd: number | null;
  currency: 'USD';
}

export interface ContractUsageSummary {
  totalEstimatedCostUsd: number;
  totalPromptTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalProcessedPages: number;
  totalGroundedSearchRequests: number;
  breakdown: ContractUsageMetric[];
}

export interface ContractUsageOverview {
  extraction: ContractUsageSummary | null;
  aiExtraction: ContractUsageSummary | null;
  aiAudit: ContractUsageSummary | null;
  total: ContractUsageSummary | null;
}

export interface ExtractedDocumentResult {
  title: string;
  url: string;
  mimeType: string;
  matchedKeywords: string[];
  extractionMethod: 'pdf-text' | 'mistral-ocr' | null;
  extractedText: string | null;
  candidatePages: number[] | null;
  tables: ExtractedPriceTable[];
  usage: ContractUsageMetric | null;
  error?: string;
}

export interface ContractExtractionResult {
  status:
    | 'completed'
    | 'completed_text'
    | 'completed_no_tables'
    | 'no_contract_documents'
    | 'no_relevant_documents'
    | 'requires_mistral_config';
  contract: {
    id: string;
    contractID: string | null;
    tenderId: string;
    tenderPublicId: string | null;
  };
  totalDocuments: number;
  relevantDocuments: number;
  processedDocuments: number;
  documents: ExtractedDocumentResult[];
  usageSummary: ContractUsageSummary | null;
}

export interface ContractExtractionStatusResponse {
  contract: {
    id: string;
    contractID: string | null;
    tenderId: string;
    tenderPublicId: string | null;
  };
  runId: string | null;
  jobId: string | null;
  state: string;
  result: ContractExtractionResult | null;
  failureReason: string | null;
  attemptsMade?: number;
  timestamp?: number | null;
  finishedOn?: number | null;
}

export interface AiExtractedContractItem {
  source: 'document' | 'api-fallback';
  documentTitle: string | null;
  extractionMethod: 'pdf-text' | 'mistral-ocr' | null;
  itemName: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  currency: string | null;
  vat: string | null;
  sourceSnippet: string | null;
  confidence: number | null;
}

export interface ContractAiExtractionResult {
  status:
    | 'completed'
    | 'completed_api_fallback_only'
    | 'completed_no_items'
    | 'no_extracted_text'
    | 'requires_gemini_config';
  contract: {
    id: string;
    contractID: string | null;
    tenderId: string;
    tenderPublicId: string | null;
  };
  model: string;
  documentsAnalyzed: number;
  sourceTextLength: number;
  itemsExtracted: number;
  items: AiExtractedContractItem[];
  usage: ContractUsageSummary | null;
}

export interface ContractAiExtractionStatusResponse {
  contract: {
    id: string;
    contractID: string | null;
    tenderId: string;
    tenderPublicId: string | null;
  };
  runId: string | null;
  state: string;
  result: ContractAiExtractionResult | null;
  failureReason: string | null;
  timestamp?: number | null;
  finishedOn?: number | null;
}

export interface ContractAuditSource {
  title: string | null;
  url: string | null;
}

export type ContractAuditRiskLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'critical'
  | 'unknown';

export interface AiAuditedContractItem {
  itemIndex: number;
  itemName: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  currency: string | null;
  riskLevel: ContractAuditRiskLevel;
  riskScore: number | null;
  marketUnitPrice: number | null;
  marketPriceMin: number | null;
  marketPriceMax: number | null;
  overpricingPercent: number | null;
  findings: string | null;
  recommendation: string | null;
  confidence: number | null;
}

export interface ContractFinalAuditAnalysis {
  procurementInfo: {
    title: string | null;
    identifier: string | null;
    dateSigned: string | null;
    customer: string | null;
    contractor: string | null;
    procurementSubject: string | null;
  };
  dataAvailability: {
    providedDocuments: string[];
    missingCriticalDocuments: string[];
  };
  financialPricing: {
    totalCost: string | null;
    unitPrice: string | null;
    keyPriceElements: string | null;
  };
  marketAnalytics: {
    estimatedMarketPrice: string | null;
    comparisonMethod: string | null;
    numericComparison: string | null;
    itemBreakdown: string | null;
  };
  conclusion: {
    overpricingSigns: 'yes' | 'no' | 'insufficient';
    estimatedDeviation: string | null;
    comment: string | null;
  };
}

export interface ContractAuditReportBlockItem {
  type: 'line' | 'text' | 'list';
  label: string;
  value: string | null;
  items?: string[];
}

export interface ContractAuditReportBlock {
  key:
    | 'procurement-info'
    | 'data-availability'
    | 'financial-pricing'
    | 'market-analytics'
    | 'conclusion';
  title: string;
  items: ContractAuditReportBlockItem[];
}

export interface ContractAuditReportDocument {
  version: 1;
  generatedAt: string | null;
  contract: {
    id: string;
    contractID: string | null;
    tenderId: string;
    tenderPublicId: string | null;
  };
  blocks: ContractAuditReportBlock[];
}

export interface ContractAiAuditResult {
  status:
    | 'completed'
    | 'completed_no_items'
    | 'no_items_to_audit'
    | 'no_document_items_to_audit'
    | 'requires_gemini_config';
  contract: {
    id: string;
    contractID: string | null;
    tenderId: string;
    tenderPublicId: string | null;
  };
  model: string;
  itemsAudited: number;
  flaggedItemsCount: number;
  overallRiskLevel: ContractAuditRiskLevel;
  overallScore: number | null;
  summary: string | null;
  items: AiAuditedContractItem[];
  contractAnalysis: ContractFinalAuditAnalysis | null;
  reportDocument: ContractAuditReportDocument | null;
  searchQueries: string[];
  sources: ContractAuditSource[];
  usage: ContractUsageSummary | null;
}

export interface ContractAiAuditStatusResponse {
  contract: {
    id: string;
    contractID: string | null;
    tenderId: string;
    tenderPublicId: string | null;
  };
  runId: string | null;
  state: string;
  result: ContractAiAuditResult | null;
  failureReason: string | null;
  timestamp?: number | null;
  finishedOn?: number | null;
}

export type ResolvedContractItemPriceSource =
  | 'api'
  | 'document'
  | 'document-derived'
  | 'conflict'
  | 'missing';

export interface ResolvedContractItemMatch {
  documentTitle: string | null;
  documentUrl: string | null;
  page: number | null;
  rowIndex: number | null;
  confidence: number | null;
}

export interface ResolvedContractItem {
  description: string | null;
  quantity: number | null;
  unit: string | null;
  currency: string | null;
  classification: {
      id: string | null;
      description: string | null;
  } | null;
  apiDescription: string | null;
  apiQuantity: number | null;
  apiUnit: string | null;
  apiUnitPrice: number | null;
  apiTotalPrice: number | null;
  documentDescription: string | null;
  documentQuantity: number | null;
  documentUnit: string | null;
  documentUnitPrice: number | null;
  documentTotalPrice: number | null;
  resolvedUnitPrice: number | null;
  resolvedTotalPrice: number | null;
  priceSource: ResolvedContractItemPriceSource;
  matchConfidence: number | null;
  matchedDocument: ResolvedContractItemMatch | null;
}
