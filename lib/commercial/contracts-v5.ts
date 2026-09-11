export const COMMERCIAL_CONTRACT_VERSION_V5 = '2026-09-v5';

export type AiOperation = 'short_action' | 'pdf_import';
export type AiRequestStatus =
  | 'reserved'
  | 'succeeded'
  | 'released'
  | 'uncertain';

export interface AiRewriteRequest {
  kind: 'rewrite';
  instruction: string;
  text: string;
}

export interface AiTranslationSegment {
  index: number;
  type: string;
  text: string;
}

export interface AiTranslationRequest {
  kind: 'translate';
  targetLanguage: string;
  segments: AiTranslationSegment[];
}

export type AiActionRequest = AiRewriteRequest | AiTranslationRequest;

export interface AiPdfImportRequest {
  extractedText: string;
}

export type AiActionResult =
  | { kind: 'text'; text: string }
  | {
      kind: 'translations';
      translations: Array<{ index: number; text: string }>;
    };

export interface AiPdfImportResult {
  kind: 'scenario_json';
  scenarioJson: string;
}

export interface AiQuotaView {
  used: number;
  limit: number;
  periodStartsAt: string;
  periodEndsAt: string;
}

export interface AiExecutionResponse<T> {
  contractVersion: '2026-09-v5';
  operation: AiOperation;
  status: AiRequestStatus;
  result: T | null;
  replayed: boolean;
  quota: AiQuotaView;
  request_id: string;
}

export interface AiReconcileRequest {
  idempotencyKey: string;
}

export interface AiReconcileResponse {
  contractVersion: '2026-09-v5';
  operation: AiOperation;
  status: AiRequestStatus;
  replayed: true;
  quota: AiQuotaView;
  request_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readQuota(value: unknown): AiQuotaView {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.used) ||
    !Number.isSafeInteger(value.limit) ||
    typeof value.periodStartsAt !== 'string' ||
    typeof value.periodEndsAt !== 'string'
  ) {
    throw new Error('Invalid AI quota response.');
  }
  return value as unknown as AiQuotaView;
}

export function parseAiExecutionResponse<T>(
  value: unknown,
  operation: AiOperation,
): AiExecutionResponse<T> {
  if (
    !isRecord(value) ||
    value.contractVersion !== COMMERCIAL_CONTRACT_VERSION_V5 ||
    value.operation !== operation ||
    !['reserved', 'succeeded', 'released', 'uncertain'].includes(
      String(value.status),
    ) ||
    typeof value.replayed !== 'boolean' ||
    typeof value.request_id !== 'string' ||
    !(value.result === null || isRecord(value.result))
  ) {
    throw new Error('Invalid commercial AI response.');
  }
  return {
    ...value,
    quota: readQuota(value.quota),
  } as unknown as AiExecutionResponse<T>;
}

export function parseAiReconcileResponse(value: unknown): AiReconcileResponse {
  if (
    !isRecord(value) ||
    value.contractVersion !== COMMERCIAL_CONTRACT_VERSION_V5 ||
    !['short_action', 'pdf_import'].includes(String(value.operation)) ||
    !['reserved', 'succeeded', 'released', 'uncertain'].includes(
      String(value.status),
    ) ||
    value.replayed !== true ||
    typeof value.request_id !== 'string'
  ) {
    throw new Error('Invalid AI reconciliation response.');
  }
  return {
    ...value,
    quota: readQuota(value.quota),
  } as unknown as AiReconcileResponse;
}
