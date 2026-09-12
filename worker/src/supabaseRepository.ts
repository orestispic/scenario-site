import type { EntitlementSnapshot } from '../../lib/commercial/contracts.ts';
import type {
  DeviceView,
  UsageView,
} from '../../lib/commercial/contracts-v2.ts';
import type {
  ActivateDeviceInput,
  CommercialRepository,
  EntitlementRecord,
  ProfileRecord,
  WorkerEnvironment,
} from './types.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';

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
      `/rest/v1/devices?user_id=eq.${encodeURIComponent(profileId)}&select=id,label,platform,status,last_seen_at&order=created_at.asc`,
    );
    return rows.map(this.mapDevice);
  }

  async activateDevice(
    profileId: string,
    input: ActivateDeviceInput,
  ): Promise<DeviceView> {
    const row = await this.write<DatabaseDevice>(
      '/rest/v1/rpc/activate_device',
      {
        p_profile_id: profileId,
        p_device_fingerprint_hash: input.fingerprintHash,
        p_platform: input.platform,
        p_label: input.label,
      },
    );
    return this.mapDevice(row);
  }

  async deactivateDevice(profileId: string, deviceId: string): Promise<void> {
    await this.write(
      `/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}&user_id=eq.${encodeURIComponent(profileId)}`,
      {
        status: 'revoked',
        revoked_at: new Date().toISOString(),
      },
      'PATCH',
    );
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
    const response = await this.fetcher(
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
  });

  private async read<T>(path: string): Promise<T> {
    const endpoint = path.split('?')[0] ?? 'unknown';
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher(
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
    const response = await this.fetcher(
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
    if (!response.ok)
      throw new RepositoryError(`Database write failed (${response.status})`);
    const value = (await response.json()) as T | T[];
    return (Array.isArray(value) ? value[0] : value) as T;
  }

  private serviceHeaders(): Record<string, string> {
    return supabaseAdminHeaders(this.environment);
  }
}
