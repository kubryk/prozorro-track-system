export interface ExtractionJobPayload {
  contractDbId: string;
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

export interface ExtractedDocumentResult {
  title: string;
  url: string;
  mimeType: string;
  matchedKeywords: string[];
  candidatePages: number[] | null;
  tables: ExtractedPriceTable[];
  error?: string;
}

export interface ContractExtractionResult {
  status:
    | 'completed'
    | 'completed_no_tables'
    | 'no_contract_documents'
    | 'no_relevant_documents'
    | 'requires_google_config';
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
}
