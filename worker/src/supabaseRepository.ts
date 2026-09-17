import type { EntitlementSnapshot } from '../../lib/commercial/contracts.ts';
import type {
  DeviceView,
  UsageView,
} from '../../lib/commercial/contracts-v2.ts';
import type {
  ActivateDeviceInput,
  CommercialRepository,
  DeviceChallengeRecord,
  DeviceProofRecord,
  DeviceSessionClaim,
  DeviceSessionLease,
  EntitlementRecord,
  ProfileRecord,
  WorkerEnvironment,
} from './types.ts';
import { CommercialRepositoryError } from './types.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';
import { detachedFetch } from './detachedFetch.ts';

type DatabaseProfile = {
  id: string;
  auth_user_id: string;
  email: string;
  display_name: string | null;
  role: ProfileRecord['role'];
};
type DatabaseDevice = {
  id: string;
  label: string | null;
  platform: DeviceView['platform'];
  status: DeviceView['status'];
  last_seen_at: string;
  first_activated_at: string;
  client_version: string | null;
  public_key_jwk: JsonWebKey | null;
  key_thumbprint: string | null;
};
type DatabaseDeviceChallenge = {
  id: string;
  user_id: string;
  device_id: string | null;
  purpose: DeviceChallengeRecord['purpose'];
  nonce: string;
  expires_at: string;
};
type DatabaseSnapshot = {
  id: string;
  configuration_version_id: string;
  effective_at: string;
  expires_at: string | null;
  payload: {
    entitlements?: EntitlementSnapshot['entitlements'];
    offline_valid_until?: string;
    device_limit?: number;
    quota_limits?: Record<string, number>;
    quota_periods?: Record<string, 'month' | 'lifetime'>;
  };
};
type DatabaseCompatibility = {
  minimum_supported_version: string;
  effective_at: string;
  message: string | null;
};

export class RepositoryError extends Error {}

export class SupabaseRestRepository implements CommercialRepository {
  constructor(
    private readonly environment: WorkerEnvironment,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getConfiguration() {
    const configurations = await this.read<Array<{ version_number: number }>>(
      '/rest/v1/offer_configuration_versions?status=eq.active&select=version_number&order=effective_at.desc&limit=1',
    );
    const offers = await this.read<unknown[]>(
      '/rest/v1/offer_configuration_items?is_visible=eq.true&select=*,offers!inner(offer_code),offer_configuration_versions!inner(status)&offer_configuration_versions.status=eq.active&order=price_minor.asc',
    );
    const compatibility = await this.read<DatabaseCompatibility[]>(
      '/rest/v1/client_compatibility_rules?select=minimum_supported_version,effective_at,message&order=effective_at.desc',
    );
    return {
      version: String(configurations[0]?.version_number ?? 'unconfigured'),
      offers,
      compatibility: compatibility.map((rule) => ({
        minimumSupportedVersion: rule.minimum_supported_version,
        effectiveAt: rule.effective_at,
        message: rule.message,
      })),
    };
  }

  async getProfile(authUserId: string): Promise<ProfileRecord | null> {
    const rows = await this.read<DatabaseProfile[]>(
      `/rest/v1/profiles?auth_user_id=eq.${encodeURIComponent(authUserId)}&deleted_at=is.null&select=id,auth_user_id,email,display_name,role&limit=1`,
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          authUserId: row.auth_user_id,
          account: {
            id: row.id,
            email: row.email,
            displayName: row.display_name,
          },
          role: row.role,
        }
      : null;
  }

  async getEntitlements(profileId: string): Promise<EntitlementRecord | null> {
    const now = new Date();
    const row = await this.write<DatabaseSnapshot>(
      '/rest/v1/rpc/current_entitlement_snapshot',
      { p_profile_id: profileId },
    );
    if (
      !row ||
      (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) ||
      !Array.isArray(row.payload.entitlements) ||
      typeof row.payload.device_limit !== 'number' ||
      !row.payload.offline_valid_until
    )
      return null;
    return {
      snapshot: {
        id: row.id,
        configurationVersion: row.configuration_version_id,
        issuedAt: row.effective_at,
        offlineValidUntil: row.payload.offline_valid_until,
        entitlements: row.payload.entitlements,
      },
      deviceLimit: row.payload.device_limit,
      quotaLimits: row.payload.quota_limits ?? {},
      quotaPeriods: row.payload.quota_periods ?? {},
    };
  }

  async listDevices(profileId: string): Promise<DeviceView[]> {
    const rows = await this.read<DatabaseDevice[]>(
      `/rest/v1/devices?user_id=eq.${encodeURIComponent(profileId)}&select=id,label,platform,status,last_seen_at,first_activated_at,client_version,public_key_jwk,key_thumbprint&order=created_at.asc`,
    );
    return rows.map(this.mapDevice);
  }

  async findActiveDevice(profileId: string, fingerprintHash: string): Promise<DeviceView | null> {
    const rows = await this.read<DatabaseDevice[]>(
      `/rest/v1/devices?user_id=eq.${encodeURIComponent(profileId)}&device_fingerprint_hash=eq.${encodeURIComponent(fingerprintHash)}&status=eq.active&select=id,label,platform,status,last_seen_at,first_activated_at,client_version,public_key_jwk,key_thumbprint&limit=1`,
    );
    return rows[0] ? this.mapDevice(rows[0]) : null;
  }

  async activateDevice(
    profileId: string,
    input: ActivateDeviceInput,
  ): Promise<DeviceView> {
    const row = input.publicKey && input.keyThumbprint && input.clientVersion
      ? await this.write<DatabaseDevice>('/rest/v1/rpc/activate_device_v2', {
          p_profile_id: profileId,
          p_device_fingerprint_hash: input.fingerprintHash,
          p_key_thumbprint: input.keyThumbprint,
          p_public_key_jwk: input.publicKey,
          p_platform: input.platform,
          p_label: input.label,
          p_client_version: input.clientVersion,
        })
      : await this.write<DatabaseDevice>('/rest/v1/rpc/activate_device', {
          p_profile_id: profileId,
          p_device_fingerprint_hash: input.fingerprintHash,
          p_platform: input.platform,
          p_label: input.label,
        });
    return this.mapDevice(row);
  }

  async deactivateDevice(profileId: string, deviceId: string): Promise<void> {
    await this.write('/rest/v1/rpc/deactivate_device_v2', {
      p_profile_id: profileId,
      p_device_id: deviceId,
    });
  }

  async claimDeviceSession(profileId: string, deviceId: string, force: boolean): Promise<DeviceSessionClaim> {
    const value = await this.write<Record<string, unknown>>('/rest/v1/rpc/claim_device_session_v17', {
      p_profile_id: profileId,
      p_device_id: deviceId,
      p_force: force,
      p_ttl_seconds: 90,
    });
    if (value.status === 'conflict') {
      const device = value.activeDevice as Record<string, unknown> | undefined;
      if (!device || typeof value.expiresAt !== 'string') throw new RepositoryError('Invalid device session conflict');
      return {
        status: 'conflict',
        expiresAt: value.expiresAt,
        activeDevice: {
          id: String(device.id),
          label: typeof device.label === 'string' ? device.label : null,
          platform: device.platform === 'macos' ? 'macos' : 'windows',
          status: 'active',
          lastSeenAt: String(device.lastSeenAt),
          firstActivatedAt: typeof device.firstActivatedAt === 'string' ? device.firstActivatedAt : undefined,
          clientVersion: typeof device.clientVersion === 'string' ? device.clientVersion : null,
          hasCryptographicIdentity: true,
        },
      };
    }
    return { status: 'claimed', ...this.readDeviceSessionLease(value) };
  }

  async heartbeatDeviceSession(profileId: string, deviceId: string, leaseId: string): Promise<DeviceSessionLease> {
    const value = await this.write<Record<string, unknown>>('/rest/v1/rpc/heartbeat_device_session_v17', {
      p_profile_id: profileId,
      p_device_id: deviceId,
      p_lease_id: leaseId,
      p_ttl_seconds: 90,
    });
    if (value.status !== 'active')
      throw new CommercialRepositoryError(409, 'device_session_replaced', 'Cet appareil n’est plus la session active.');
    return this.readDeviceSessionLease(value);
  }

  async releaseDeviceSession(profileId: string, deviceId: string, leaseId: string): Promise<void> {
    await this.write('/rest/v1/rpc/release_device_session_v17', {
      p_profile_id: profileId,
      p_device_id: deviceId,
      p_lease_id: leaseId,
    });
  }

  async assertDeviceSession(profileId: string, deviceId: string): Promise<void> {
    const active = await this.write<boolean>('/rest/v1/rpc/is_device_session_active_v17', {
      p_profile_id: profileId,
      p_device_id: deviceId,
    });
    if (!active)
      throw new CommercialRepositoryError(409, 'device_session_required', 'Cet appareil n’est pas la session active.');
  }

  async getDeviceForProof(profileId: string, deviceId: string): Promise<DeviceProofRecord | null> {
    const rows = await this.read<DatabaseDevice[]>(
      `/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(profileId)}&select=id,status,public_key_jwk,key_thumbprint,label,platform,last_seen_at,first_activated_at,client_version&limit=1`,
    );
    const row = rows[0];
    return row ? { id: row.id, profileId, status: row.status, publicKey: row.public_key_jwk, keyThumbprint: row.key_thumbprint } : null;
  }

  async findActiveDeviceByKey(profileId: string, keyThumbprint: string): Promise<DeviceProofRecord | null> {
    const rows = await this.read<DatabaseDevice[]>(
      `/rest/v1/devices?user_id=eq.${encodeURIComponent(profileId)}&key_thumbprint=eq.${encodeURIComponent(keyThumbprint)}&status=eq.active&select=id,status,public_key_jwk,key_thumbprint,label,platform,last_seen_at,first_activated_at,client_version&limit=1`,
    );
    const row = rows[0];
    return row ? { id: row.id, profileId, status: row.status, publicKey: row.public_key_jwk, keyThumbprint: row.key_thumbprint } : null;
  }

  async createDeviceChallenge(input: Omit<DeviceChallengeRecord, 'id'>): Promise<DeviceChallengeRecord> {
    const row = await this.write<DatabaseDeviceChallenge>('/rest/v1/device_challenges', {
      user_id: input.profileId,
      device_id: input.deviceId,
      purpose: input.purpose,
      nonce: input.nonce,
      expires_at: input.expiresAt,
    });
    return this.mapChallenge(row);
  }

  async consumeDeviceChallenge(profileId: string, challengeId: string, purpose: DeviceChallengeRecord['purpose'], deviceId: string | null): Promise<DeviceChallengeRecord> {
    const row = await this.write<DatabaseDeviceChallenge>('/rest/v1/rpc/consume_device_challenge', {
      p_profile_id: profileId,
      p_challenge_id: challengeId,
      p_purpose: purpose,
      p_device_id: deviceId,
    });
    return this.mapChallenge(row);
  }

  async markDeviceSeen(profileId: string, deviceId: string, clientVersion?: string): Promise<void> {
    await this.write(
      `/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(profileId)}&status=eq.active`,
      { last_seen_at: new Date().toISOString(), ...(clientVersion ? { client_version: clientVersion.slice(0, 40) } : {}) },
      'PATCH',
    );
  }

  async recordDeviceLicense(input: {
    id: string; profileId: string; deviceId: string; snapshotId: string; keyId: string;
    formatVersion: number; issuedAt: string; entitlementValidUntil: string; offlineValidUntil: string;
  }): Promise<void> {
    await this.write('/rest/v1/device_licenses', {
      id: input.id,
      user_id: input.profileId,
      device_id: input.deviceId,
      entitlement_snapshot_id: input.snapshotId,
      key_id: input.keyId,
      format_version: input.formatVersion,
      issued_at: input.issuedAt,
      entitlement_valid_until: input.entitlementValidUntil,
      offline_valid_until: input.offlineValidUntil,
    });
  }

  async getUsage(profileId: string): Promise<UsageView[]> {
    const rows = await this.read<
      Array<{ quota_code: string; quantity: number }>
    >(
      `/rest/v1/ai_usage_events?user_id=eq.${encodeURIComponent(profileId)}&select=quota_code,quantity`,
    );
    const totals = new Map<string, number>();
    for (const row of rows)
      totals.set(
        row.quota_code,
        (totals.get(row.quota_code) ?? 0) + row.quantity,
      );
    return [...totals].map(([quotaCode, used]) => ({
      quotaCode,
      used,
      limit: null,
      periodEndsAt: null,
    }));
  }

  async logout(accessToken: string): Promise<void> {
    const response = await detachedFetch(
      this.fetcher,
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/logout`,
      {
        method: 'POST',
        headers: {
          apikey: this.environment.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!response.ok) throw new RepositoryError('Supabase logout failed');
  }

  async appendAudit(event: {
    profileId: string | null;
    action: string;
    entityType: string;
    entityId?: string;
    requestId: string;
  }): Promise<void> {
    await this.write('/rest/v1/audit_log', {
      actor_user_id: event.profileId,
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId ?? null,
      request_id: event.requestId,
    });
  }

  private readonly mapDevice = (row: DatabaseDevice): DeviceView => ({
    id: row.id,
    label: row.label,
    platform: row.platform,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    firstActivatedAt: row.first_activated_at,
    clientVersion: row.client_version,
    hasCryptographicIdentity: Boolean(row.public_key_jwk && row.key_thumbprint),
  });

  private readonly mapChallenge = (row: DatabaseDeviceChallenge): DeviceChallengeRecord => ({
    id: row.id,
    profileId: row.user_id,
    deviceId: row.device_id,
    purpose: row.purpose,
    nonce: row.nonce,
    expiresAt: row.expires_at,
  });

  private readonly readDeviceSessionLease = (value: Record<string, unknown>): DeviceSessionLease => {
    if (typeof value.leaseId !== 'string' || typeof value.deviceId !== 'string' || typeof value.expiresAt !== 'string')
      throw new RepositoryError('Invalid device session lease');
    return { leaseId: value.leaseId, deviceId: value.deviceId, expiresAt: value.expiresAt };
  };

  private async read<T>(path: string): Promise<T> {
    const endpoint = path.split('?')[0] ?? 'unknown';
    let response: Response;
    try {
      response = await detachedFetch(
        this.fetcher,
        `${this.environment.SUPABASE_URL.replace(/\/$/, '')}${path}`,
        { headers: this.serviceHeaders() },
      );
    } catch {
      console.warn(
        JSON.stringify({
          event: 'supabase.read_failed',
          endpoint,
          status: 0,
          reason: 'network',
        }),
      );
      throw new RepositoryError('Database read failed (network)');
    }
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          event: 'supabase.read_failed',
          endpoint,
          status: response.status,
          reason: 'response',
        }),
      );
      throw new RepositoryError(`Database read failed (${response.status})`);
    }
    try {
      return (await response.json()) as T;
    } catch {
      console.warn(
        JSON.stringify({
          event: 'supabase.read_failed',
          endpoint,
          status: response.status,
          reason: 'invalid_json',
        }),
      );
      throw new RepositoryError('Database read failed (invalid response)');
    }
  }

  private async write<T = unknown>(
    path: string,
    body: unknown,
    method = 'POST',
  ): Promise<T> {
    const response = await detachedFetch(
      this.fetcher,
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}${path}`,
      {
        method,
        headers: {
          ...this.serviceHeaders(),
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      let message = '';
      try {
        const errorBody = (await response.json()) as { message?: unknown };
        message = typeof errorBody.message === 'string' ? errorBody.message : '';
      } catch { /* response body is optional */ }
      const code = [
        'device_limit_reached', 'device_not_found', 'device_challenge_invalid',
        'device_challenge_consumed', 'device_challenge_expired',
        'missing_device_entitlement', 'invalid_device_key', 'device_identity_conflict',
      ].find(candidate => message.includes(candidate));
      if (code) throw new CommercialRepositoryError(code === 'device_not_found' ? 404 : ['device_limit_reached', 'device_identity_conflict', 'device_challenge_consumed'].includes(code) ? 409 : 400, code, code);
      throw new RepositoryError(`Database write failed (${response.status})`);
    }
    const value = (await response.json()) as T | T[];
    return (Array.isArray(value) ? value[0] : value) as T;
  }

  private serviceHeaders(): Record<string, string> {
    return supabaseAdminHeaders(this.environment);
  }
}
