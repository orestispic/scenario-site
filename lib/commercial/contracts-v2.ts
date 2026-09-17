import type {
  AccountIdentity,
  ClientCompatibility,
  EntitlementSnapshot,
} from "./contracts.ts";

export const COMMERCIAL_CONTRACT_VERSION_V2 = "2026-09-v2";

export interface ApiErrorV2 {
  code: string;
  message: string;
  request_id: string;
}

export interface SignedOfflineGrant {
  format: "scenario.offline-grant.v1";
  algorithm: "ES256";
  keyId: string;
  payload: string;
  signature: string;
}

export interface OfflineGrantPayload {
  userId: string;
  deviceId: string | null;
  snapshotId: string;
  configurationVersion: string;
  issuedAt: string;
  expiresAt: string;
}

export interface PublicConfiguration {
  version: string;
  environment: "test" | "staging" | "production";
  offers: unknown[];
  compatibility: ClientCompatibility[];
  offlineGrantPublicKey: JsonWebKey;
  offlineGrantKeyId: string;
  offlineGrantPublicKeys?: Record<string, JsonWebKey>;
}

export interface MeResponse {
  account: AccountIdentity;
  role: "customer" | "support" | "admin";
}

export interface EntitlementsResponse {
  snapshot: EntitlementSnapshot;
  offlineGrant: SignedOfflineGrant;
}

export interface DeviceView {
  id: string;
  label: string | null;
  platform: "windows" | "macos";
  status: "active" | "revoked";
  lastSeenAt: string;
  firstActivatedAt?: string;
  clientVersion?: string | null;
  hasCryptographicIdentity?: boolean;
}

export interface DeviceChallenge {
  id: string;
  purpose: "activation" | "license_renewal";
  message: string;
  expiresAt: string;
}

export interface UsageView {
  quotaCode: string;
  used: number;
  limit: number | null;
  periodEndsAt: string | null;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}
