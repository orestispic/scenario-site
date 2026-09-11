import type {
  AiOperation,
  AiRequestStatus,
} from '../../lib/commercial/contracts-v5.ts';
import type { WorkerEnvironment } from './types.ts';
import { CommercialRepositoryError } from './types.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';

export interface AiReservation {
  id: string;
  operation: AiOperation;
  status: AiRequestStatus;
  replayed: boolean;
  snapshotId: string;
  configurationVersion: string;
  used: number;
  limit: number;
  periodStartsAt: string;
  periodEndsAt: string;
}

export interface AiQuotaRepository {
  reserve(input: {
    profileId: string;
    operation: AiOperation;
    entitlementCode: string;
    quotaCode: string;
    deviceFingerprintHash: string;
    platform: 'windows' | 'macos';
    clientVersion: string;
    idempotencyKeyHash: string;
    requestFingerprint: string;
    requestId: string;
  }): Promise<AiReservation>;
  confirm(profileId: string, reservationId: string): Promise<AiReservation>;
  release(profileId: string, reservationId: string): Promise<AiReservation>;
  markUncertain(
    profileId: string,
    reservationId: string,
  ): Promise<AiReservation>;
  reconcile(
    profileId: string,
    idempotencyKeyHash: string,
  ): Promise<AiReservation | null>;
}

const KNOWN_DATABASE_ERRORS: Record<string, [number, string]> = {
  ai_device_inactive: [403, 'ai_device_inactive'],
  ai_entitlement_missing: [403, 'ai_entitlement_missing'],
  ai_idempotency_conflict: [409, 'ai_idempotency_conflict'],
  ai_quota_exhausted: [429, 'ai_quota_exhausted'],
  ai_quota_unconfigured: [503, 'ai_quota_unconfigured'],
  ai_request_missing: [404, 'ai_request_missing'],
  client_update_required: [426, 'client_update_required'],
  invalid_client_version: [400, 'invalid_client_version'],
};

export class SupabaseAiQuotaRepository implements AiQuotaRepository {
  constructor(
    private readonly environment: WorkerEnvironment,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  reserve(
    input: Parameters<AiQuotaRepository['reserve']>[0],
  ): Promise<AiReservation> {
    return this.rpc('/rest/v1/rpc/reserve_ai_quota', {
      p_profile_id: input.profileId,
      p_operation: input.operation,
      p_entitlement_code: input.entitlementCode,
      p_quota_code: input.quotaCode,
      p_device_fingerprint_hash: input.deviceFingerprintHash,
      p_platform: input.platform,
      p_client_version: input.clientVersion,
      p_idempotency_key_hash: input.idempotencyKeyHash,
      p_request_fingerprint: input.requestFingerprint,
      p_request_id: input.requestId,
    });
  }

  confirm(profileId: string, reservationId: string): Promise<AiReservation> {
    return this.rpc('/rest/v1/rpc/confirm_ai_quota', {
      p_profile_id: profileId,
      p_reservation_id: reservationId,
    });
  }

  release(profileId: string, reservationId: string): Promise<AiReservation> {
    return this.rpc('/rest/v1/rpc/release_ai_quota', {
      p_profile_id: profileId,
      p_reservation_id: reservationId,
    });
  }

  markUncertain(
    profileId: string,
    reservationId: string,
  ): Promise<AiReservation> {
    return this.rpc('/rest/v1/rpc/mark_ai_quota_uncertain', {
      p_profile_id: profileId,
      p_reservation_id: reservationId,
    });
  }

  async reconcile(
    profileId: string,
    idempotencyKeyHash: string,
  ): Promise<AiReservation | null> {
    return this.rpc('/rest/v1/rpc/get_ai_request_status', {
      p_profile_id: profileId,
      p_idempotency_key_hash: idempotencyKeyHash,
    });
  }

  private async rpc<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetcher(
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}${path}`,
      {
        method: 'POST',
        headers: {
          ...supabaseAdminHeaders(this.environment),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      const match = Object.entries(KNOWN_DATABASE_ERRORS).find(([key]) =>
        text.includes(key),
      );
      if (match)
        throw new CommercialRepositoryError(
          match[1][0],
          match[1][1],
          'Opération IA refusée.',
        );
      throw new CommercialRepositoryError(
        503,
        'ai_quota_unavailable',
        'Compteur IA temporairement indisponible.',
      );
    }
    return response.json() as Promise<T>;
  }
}
