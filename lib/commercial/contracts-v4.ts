import type {
  EntitlementsResponse,
  OfflineGrantPayload,
} from './contracts-v2.ts';
export const COMMERCIAL_CONTRACT_VERSION_V4 = '2026-09-v4';
export interface BoundOfflineGrantPayload extends OfflineGrantPayload {
  contractVersion: '2026-09-v4';
  snapshotJson: string;
}
export interface BoundEntitlementsResponse extends EntitlementsResponse {
  contractVersion: '2026-09-v4';
}
