import type {
  DeviceView,
  MeResponse,
  OfflineGrantPayload,
  PublicConfiguration,
  SignedOfflineGrant,
  UsageView,
} from "../../lib/commercial/contracts-v2.ts";
import type { EntitlementSnapshot } from "../../lib/commercial/contracts.ts";

export interface WorkerEnvironment {
  SCENARIO_ENVIRONMENT: "test" | "staging" | "production";
  API_ALLOWED_ORIGINS: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_AUDIENCE?: string;
  DEVICE_FINGERPRINT_PEPPER: string;
  OFFLINE_GRANT_PRIVATE_JWK: string;
  OFFLINE_GRANT_PUBLIC_JWK: string;
  OFFLINE_GRANT_KEY_ID: string;
  RATE_LIMIT_MAX_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
}

export interface AuthenticatedIdentity {
  authUserId: string;
  accessToken: string;
}

export interface ProfileRecord extends MeResponse {
  id: string;
  authUserId: string;
}

export interface EntitlementRecord {
  snapshot: EntitlementSnapshot;
  deviceLimit: number;
}

export interface ActivateDeviceInput {
  fingerprintHash: string;
  label: string;
  platform: "windows" | "macos";
}

export interface CommercialRepository {
  getConfiguration(): Promise<Omit<PublicConfiguration, "environment" | "offlineGrantPublicKey" | "offlineGrantKeyId">>;
  getProfile(authUserId: string): Promise<ProfileRecord | null>;
  getEntitlements(profileId: string): Promise<EntitlementRecord | null>;
  listDevices(profileId: string): Promise<DeviceView[]>;
  activateDevice(profileId: string, input: ActivateDeviceInput): Promise<DeviceView>;
  deactivateDevice(profileId: string, deviceId: string): Promise<void>;
  getUsage(profileId: string): Promise<UsageView[]>;
  logout(accessToken: string): Promise<void>;
  appendAudit(event: { profileId: string | null; action: string; entityType: string; entityId?: string; requestId: string }): Promise<void>;
}

export interface TokenVerifier {
  verify(authorizationHeader: string | null): Promise<AuthenticatedIdentity>;
}

export interface OfflineGrantSigner {
  readonly keyId: string;
  getPublicKey(): Promise<JsonWebKey>;
  sign(payload: OfflineGrantPayload): Promise<SignedOfflineGrant>;
}

export interface RateLimiter {
  allow(key: string, now: number): Promise<boolean>;
}

export class CommercialRepositoryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "CommercialRepositoryError";
  }
}

export type WorkerDependencies = {
  environment: "test" | "staging" | "production";
  allowedOrigins: string[];
  repository: CommercialRepository;
  tokenVerifier: TokenVerifier;
  offlineGrantSigner: OfflineGrantSigner;
  rateLimiter: RateLimiter;
};
