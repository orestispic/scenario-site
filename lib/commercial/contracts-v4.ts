import type {
  EntitlementsResponse,
  OfflineGrantPayload,
} from './contracts-v2.ts';
export const COMMERCIAL_CONTRACT_VERSION_V4 = '2026-09-v4';
export interface BoundOfflineGrantPayload extends OfflineGrantPayload {
  contractVersion: '2026-09-v4';
  snapshotJson: string;
  licenseId?: string;
  licenseFormatVersion?: number;
  deviceKeyThumbprint?: string;
  plan?: string | null;
  entitlementValidUntil?: string;
  entitlements?: EntitlementsResponse['snapshot']['entitlements'];
}
export interface BoundEntitlementsResponse extends EntitlementsResponse {
  contractVersion: '2026-09-v4';
}
