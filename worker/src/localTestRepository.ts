import type { EntitlementSnapshot } from '../../lib/commercial/contracts.ts';
import type {
  DeviceView,
  UsageView,
} from '../../lib/commercial/contracts-v2.ts';
import type {
  ActivateDeviceInput,
  AuthenticatedIdentity,
  CommercialRepository,
  EntitlementRecord,
  ProfileRecord,
  TokenVerifier,
} from './types.ts';
import { CommercialRepositoryError } from './types.ts';
import { AuthenticationError } from './jwt.ts';

export type LocalTestProfile = 'discovery' | 'author' | 'studio';

type LocalProfileState = {
  profile: ProfileRecord;
  offerCode: LocalTestProfile;
  deviceLimit: number;
  entitlements: EntitlementSnapshot['entitlements'];
  quotaLimits: Record<string, number>;
  quotaPeriods: Record<string, 'month' | 'lifetime'>;
  devices: DeviceView[];
  deviceIdsByFingerprint: Map<string, string>;
  purchasedGrant: {
    snapshotId: string;
    configurationVersion: string;
    issuedAt: string;
    offlineValidUntil: string;
    expiresAt: string | null;
    deviceLimit: number;
    entitlements: EntitlementSnapshot['entitlements'];
    quotaLimits: Record<string, number>;
    quotaPeriods: Record<string, 'month' | 'lifetime'>;
  } | null;
};

const LOCAL_PROFILE_IDS: Record<LocalTestProfile, string> = {
  discovery: '10000000-0000-4000-8000-000000000001',
  author: '10000000-0000-4000-8000-000000000002',
  studio: '10000000-0000-4000-8000-000000000003',
};

function localState(
  profile: LocalTestProfile,
  deviceLimit: number,
  entitlements: EntitlementSnapshot['entitlements'],
  quotaLimits: Record<string, number> = {},
): LocalProfileState {
  const id = LOCAL_PROFILE_IDS[profile];
  return {
    profile: {
      id,
      authUserId: `local-${profile}`,
      account: {
        id,
        email: `${profile}@example.invalid`,
        displayName: `Test ${profile}`,
      },
      role: 'customer',
    },
    offerCode: profile,
    deviceLimit,
    entitlements,
    quotaLimits,
    quotaPeriods: Object.fromEntries(
      Object.keys(quotaLimits).map((code) => [code, 'month']),
    ),
    devices: [],
    deviceIdsByFingerprint: new Map(),
    purchasedGrant: null,
  };
}

export class LocalTestRepository implements CommercialRepository {
  private readonly profiles = new Map<string, LocalProfileState>([
    [
      'local-discovery',
      localState('discovery', 1, [
        { code: 'local.edit', enabled: true, value: null },
      ]),
    ],
    [
      'local-author',
      localState(
        'author',
        2,
        [
          { code: 'local.edit', enabled: true, value: null },
          { code: 'ai.actions', enabled: true, value: null },
          { code: 'ai_short_action', enabled: true, value: null },
          { code: 'ai_pdf_import', enabled: true, value: null },
        ],
        { ai_short_action: 6, ai_pdf_import: 2 },
      ),
    ],
    [
      'local-studio',
      localState(
        'studio',
        3,
        [
          { code: 'local.edit', enabled: true, value: null },
          { code: 'ai.actions', enabled: true, value: null },
          { code: 'ai_short_action', enabled: true, value: null },
          { code: 'ai_pdf_import', enabled: true, value: null },
          { code: 'cloud.sync', enabled: true, value: null },
          { code: 'cloud_sync', enabled: true, value: null },
          { code: 'scenario_versions', enabled: true, value: null },
        ],
        { ai_short_action: 10, ai_pdf_import: 4 },
      ),
    ],
  ]);
  readonly audit: Array<{ profileId: string | null; action: string }> = [];
  readonly aiUsageEvents: Array<{
    profileId: string;
    quotaCode: string;
    snapshotId: string;
    requestId: string;
  }> = [];

  async getConfiguration() {
    return {
      version: 'local-test-v1',
      offers: [...this.profiles.values()].map(({ offerCode }) => ({
        code: offerCode,
      })),
      compatibility: [],
    };
  }

  async getProfile(authUserId: string): Promise<ProfileRecord | null> {
    return this.profiles.get(authUserId)?.profile ?? null;
  }

  async getEntitlements(profileId: string): Promise<EntitlementRecord | null> {
    const state = this.findByProfileId(profileId);
    if (!state) return null;
    const purchased = state.purchasedGrant;
    if (
      purchased &&
      (!purchased.expiresAt || Date.parse(purchased.expiresAt) > Date.now())
    ) {
      return {
        snapshot: {
          id: purchased.snapshotId,
          configurationVersion: purchased.configurationVersion,
          issuedAt: purchased.issuedAt,
          offlineValidUntil: purchased.offlineValidUntil,
          entitlements: structuredClone(purchased.entitlements),
        },
        deviceLimit: purchased.deviceLimit,
        quotaLimits: structuredClone(purchased.quotaLimits),
        quotaPeriods: structuredClone(purchased.quotaPeriods),
      };
    }
    const issuedAt = new Date();
    const offlineValidUntil = new Date(issuedAt);
    offlineValidUntil.setUTCDate(offlineValidUntil.getUTCDate() + 7);
    return {
      snapshot: {
        id: `snapshot-${state.offerCode}`,
        configurationVersion: 'local-test-v1',
        issuedAt: issuedAt.toISOString(),
        offlineValidUntil: offlineValidUntil.toISOString(),
        entitlements: structuredClone(state.entitlements),
      },
      deviceLimit: state.deviceLimit,
      quotaLimits: structuredClone(state.quotaLimits),
      quotaPeriods: structuredClone(state.quotaPeriods),
    };
  }

  async listDevices(profileId: string): Promise<DeviceView[]> {
    return structuredClone(this.requireState(profileId).devices);
  }

  hasActiveDevice(
    profileId: string,
    fingerprintHash: string,
    platform: DeviceView['platform'],
  ): boolean {
    const state = this.findByProfileId(profileId);
    const id = state?.deviceIdsByFingerprint.get(fingerprintHash);
    return Boolean(
      state?.devices.some(
        (device) =>
          device.id === id &&
          device.status === 'active' &&
          device.platform === platform,
      ),
    );
  }

  minimumSupportedVersion(_platform: DeviceView['platform']): string {
    return '0.1.0';
  }

  async activateDevice(
    profileId: string,
    input: ActivateDeviceInput,
    overrideLimit?: number,
  ): Promise<DeviceView> {
    const state = this.requireState(profileId);
    const limit =
      overrideLimit ??
      (await this.getEntitlements(profileId))?.deviceLimit ??
      state.deviceLimit;
    const existingId = state.deviceIdsByFingerprint.get(input.fingerprintHash);
    const existing = state.devices.find((device) => device.id === existingId);
    const activeCount = state.devices.filter(
      (device) => device.status === 'active',
    ).length;
    if ((!existing || existing.status === 'revoked') && activeCount >= limit) {
      throw new CommercialRepositoryError(
        409,
        'device_limit_reached',
        'Limite d’appareils atteinte.',
      );
    }
    const device: DeviceView = existing ?? {
      id:
        input.fingerprintHash.slice(0, 8) +
        '-0000-4000-8000-' +
        input.fingerprintHash.slice(8, 20),
      label: input.label,
      platform: input.platform,
      status: 'active',
      lastSeenAt: new Date().toISOString(),
    };
    Object.assign(device, {
      label: input.label,
      platform: input.platform,
      status: 'active',
      lastSeenAt: new Date().toISOString(),
    });
    if (!existing) {
      state.devices.push(device);
      state.deviceIdsByFingerprint.set(input.fingerprintHash, device.id);
    }
    return structuredClone(device);
  }

  async deactivateDevice(profileId: string, deviceId: string): Promise<void> {
    const device = this.requireState(profileId).devices.find(
      (candidate) => candidate.id === deviceId,
    );
    if (!device)
      throw new CommercialRepositoryError(
        404,
        'device_not_found',
        'Appareil introuvable.',
      );
    device.status = 'revoked';
  }

  async getUsage(profileId: string): Promise<UsageView[]> {
    this.requireState(profileId);
    const totals = new Map<string, number>();
    for (const event of this.aiUsageEvents.filter(
      (item) => item.profileId === profileId,
    ))
      totals.set(event.quotaCode, (totals.get(event.quotaCode) ?? 0) + 1);
    return [...totals].map(([quotaCode, used]) => ({
      quotaCode,
      used,
      limit: null,
      periodEndsAt: null,
    }));
  }

  recordAiUsage(event: (typeof this.aiUsageEvents)[number]): void {
    if (!this.aiUsageEvents.some((item) => item.requestId === event.requestId))
      this.aiUsageEvents.push(structuredClone(event));
  }

  async logout(_accessToken?: string): Promise<void> {}

  registerLocalUser(
    authUserId: string,
    email: string,
    displayName: string,
  ): void {
    const state = localState('discovery', 1, [
      { code: 'local.edit', enabled: true, value: null },
    ]);
    const id = crypto.randomUUID();
    state.profile = {
      id,
      authUserId,
      account: { id, email, displayName },
      role: 'customer',
    };
    this.profiles.set(authUserId, state);
  }

  revokeGrant(profileId: string, snapshotId: string): void {
    const state = this.requireState(profileId);
    if (state.purchasedGrant?.snapshotId === snapshotId)
      state.purchasedGrant = null;
  }

  async appendAudit(event: {
    profileId: string | null;
    action: string;
  }): Promise<void> {
    this.audit.push(event);
  }

  grantEntitlements(
    profileId: string,
    grant: {
      configurationVersion: string;
      issuedAt: string;
      expiresAt: string | null;
      offlineValidUntil: string;
      deviceLimit: number;
      entitlements: EntitlementSnapshot['entitlements'];
      quotaLimits?: Record<string, number>;
      quotaPeriods?: Record<string, 'month' | 'lifetime'>;
    },
  ): EntitlementSnapshot {
    const state = this.requireState(profileId);
    const snapshotId = crypto.randomUUID();
    state.purchasedGrant = {
      ...structuredClone(grant),
      quotaLimits: structuredClone(grant.quotaLimits ?? state.quotaLimits),
      quotaPeriods: structuredClone(grant.quotaPeriods ?? state.quotaPeriods),
      snapshotId,
    };
    return {
      id: snapshotId,
      configurationVersion: grant.configurationVersion,
      issuedAt: grant.issuedAt,
      offlineValidUntil: grant.offlineValidUntil,
      entitlements: structuredClone(grant.entitlements),
    };
  }

  private findByProfileId(profileId: string): LocalProfileState | undefined {
    return [...this.profiles.values()].find(
      (state) => state.profile.id === profileId,
    );
  }

  private requireState(profileId: string): LocalProfileState {
    const state = this.findByProfileId(profileId);
    if (!state)
      throw new CommercialRepositoryError(
        404,
        'profile_missing',
        'Profil local introuvable.',
      );
    return state;
  }
}

/** Local-only identity selector. This file is never imported by worker/src/index.ts. */
export class LocalTestTokenVerifier implements TokenVerifier {
  async verify(
    authorizationHeader: string | null,
  ): Promise<AuthenticatedIdentity> {
    const match = /^Bearer local-test:(discovery|author|studio)$/.exec(
      authorizationHeader ?? '',
    );
    if (!match) throw new AuthenticationError();
    return {
      authUserId: `local-${match[1]}`,
      accessToken: authorizationHeader!.slice(7),
    };
  }
}
