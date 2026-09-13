import { CommercialRepositoryError, type WorkerEnvironment } from './types.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';
import { detachedFetch } from './detachedFetch.ts';
import { AiProviderError, type AiProviderInput, type AiProviderResult } from './aiProvider.ts';

export interface TokenWindow {
  usedTokens: number;
  reservedTokens: number;
  limitTokens: number;
  usedPercent: number;
  reservedPercent: number;
  costUsedPercent: number;
  resetsAt: string;
}
export interface TokenBudgets {
  daily: TokenWindow;
  monthly: TokenWindow;
  blocked: boolean;
  updatedAt: string;
}
export interface TokenModel {
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}
export interface TokenPolicy {
  version: string;
  models: Record<'short_action' | 'pdf_import', TokenModel>;
  budgets: TokenBudgets;
}
export interface TokenUsage { inputTokens: number; outputTokens: number; totalTokens: number }
export interface TokenReservation {
  id: string;
  operation: 'short_action' | 'pdf_import';
  status: 'reserved' | 'succeeded' | 'released' | 'uncertain';
  replayed: boolean;
  budgets: TokenBudgets;
}
export interface TokenRepository {
  command<T>(profileId: string, action: string, data?: Record<string, unknown>): Promise<T>;
}
export interface MeteredProvider {
  count(input: AiProviderInput, model: TokenModel): Promise<number>;
  generate(input: AiProviderInput, model: TokenModel, requestId: string): Promise<{
    usage: TokenUsage; responseId: string; readResult(): AiProviderResult;
  }>;
}
export class SupabaseTokenRepository implements TokenRepository {
  constructor(private readonly environment: WorkerEnvironment, private readonly fetcher: typeof fetch = fetch) {}
  async command<T>(profileId: string, action: string, data: Record<string, unknown> = {}): Promise<T> {
    const response = await detachedFetch(this.fetcher,
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/ai_token_command`, {
        method: 'POST', headers: { ...supabaseAdminHeaders(this.environment), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_profile_id: profileId, p_action: action, p_data: data }),
        signal: AbortSignal.timeout(15_000),
      });
    if (!response.ok) {
      const body = await response.text();
      const codes: Record<string, number> = {
        ai_budget_exhausted: 429, ai_entitlement_missing: 403, ai_device_inactive: 403,
        client_update_required: 426, ai_idempotency_conflict: 409, ai_policy_changed: 409,
        ai_request_missing: 404, ai_input_too_large: 413,
      };
      const code = Object.keys(codes).find(key => body.includes(key));
      throw new CommercialRepositoryError(code ? codes[code] : 503, code ?? 'ai_budget_unavailable',
        code === 'ai_budget_exhausted' ? 'Budget IA insuffisant pour cette demande. Consultez votre utilisation.' : 'Opération IA refusée ou temporairement indisponible.');
    }
    return response.json() as Promise<T>;
  }
}

/** The provider has no access to this repository or its credentials. */
export async function executeWithTokens(
  repository: TokenRepository, provider: MeteredProvider, profileId: string,
  input: AiProviderInput, admission: Record<string, unknown>, requestId: string,
  validate: (result: AiProviderResult) => void,
): Promise<{ reservation: TokenReservation; result: AiProviderResult | null }> {
  // Authoritative rights/device check also precedes the (non-generating) token count.
  const policy = await repository.command<TokenPolicy>(profileId, 'policy', { ...admission, operation: input.operation });
  const existing = await repository.command<TokenReservation | null>(profileId, 'lookup', { ...admission, operation: input.operation });
  if (existing) return { reservation: existing, result: null };
  if (policy.budgets.blocked) throw new CommercialRepositoryError(429, 'ai_budget_exhausted', 'Budget IA épuisé.');
  const model = policy.models[input.operation];
  let counted: number;
  try {
    counted = await provider.count(input, model);
  } catch (error) {
    if (error instanceof AiProviderError)
      throw new CommercialRepositoryError(
        error.certainty === 'definitive' ? 502 : 503,
        error.code,
        'Comptage IA temporairement indisponible. Aucun token débité.',
      );
    throw error;
  }
  if (!Number.isSafeInteger(counted) || counted < 1 || counted > model.maxInputTokens)
    throw new CommercialRepositoryError(413, 'ai_input_too_large', 'Texte trop long pour cette action IA.');
  const reservation = await repository.command<TokenReservation>(profileId, 'reserve', {
    ...admission, operation: input.operation, version: policy.version,
    // Small guard against count/generation framing differences. Actual usage replaces it.
    inputTokens: counted + 256, requestId,
  });
  if (reservation.replayed) return { reservation, result: null };
  let charged = false;
  try {
    const generated = await provider.generate(input, model, requestId);
    // Charge BEFORE parsing/validating generated text: malformed answers still consume tokens.
    const settled = await repository.command<TokenReservation>(profileId, 'settle', {
      id: reservation.id, ...generated.usage, responseId: generated.responseId,
    });
    charged = true;
    const result = generated.readResult();
    validate(result);
    return { reservation: settled, result };
  } catch (error) {
    // No retry of generation, no refund based on browser cancellation or provider timeout.
    // Unknown usage remains held until a trusted operator reconciles provider evidence.
    const rejected = !charged && error instanceof AiProviderError && error.certainty === 'definitive';
    if (!charged) await repository.command(profileId, rejected ? 'release' : 'uncertain', { id: reservation.id });
    if (rejected) throw new CommercialRepositoryError(502, 'ai_provider_rejected', 'Le fournisseur IA a refusé la demande avant génération. Aucun token débité.');
    throw new CommercialRepositoryError(charged ? 502 : 504,
      charged ? 'ai_result_invalid' : 'ai_usage_uncertain',
      charged ? 'Réponse IA inexploitable ; les tokens consommés ont été comptabilisés.' : 'Résultat IA incertain. Le budget réservé est conservé pour éviter un double appel.');
  }
}

export function tokenExecutionResponse(reservation: TokenReservation, result: AiProviderResult | null, requestId: string) {
  const monthly = reservation.budgets.monthly;
  return {
    contractVersion: '2026-09-v5', operation: reservation.operation, status: reservation.status,
    replayed: reservation.replayed, result, budgets: reservation.budgets,
    // Compatibility projection for installed v5 clients. Units are now tokens, never requests.
    quota: { used: monthly.usedTokens + monthly.reservedTokens, limit: monthly.limitTokens,
      periodStartsAt: new Date(Date.parse(monthly.resetsAt) - 1).toISOString().slice(0, 7) + '-01T00:00:00.000Z', periodEndsAt: monthly.resetsAt },
    request_id: requestId,
  };
}
