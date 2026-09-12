import type { CloudScenario } from './contracts-v6.ts';
import type { StudioInvitationView, StudioSpace } from './contracts-v7.ts';

/** Project is the cloud scenario, not an account-wide team. v1–v8 stay intact. */
export const COMMERCIAL_CONTRACT_VERSION_V9 = '2026-09-v9' as const;
export interface CloudProject extends CloudScenario {
  sharing: 'private' | 'shared';
  memberCount: number;
  /** Opaque, project-scoped channel. Null when absent or not authorized. */
  realtimeStudioId: string | null;
  /** Immutable version selected when project sharing is first enabled. */
  realtimeBaseVersionId: string | null;
  canShare: boolean;
}
export interface CloudProjectListResponse {
  contractVersion: typeof COMMERCIAL_CONTRACT_VERSION_V9;
  projects: CloudProject[];
  receivedInvitations: StudioInvitationView[];
  request_id: string;
}
export interface CloudProjectSharingResponse {
  contractVersion: typeof COMMERCIAL_CONTRACT_VERSION_V9;
  studio: StudioSpace;
  replayed: boolean;
  request_id: string;
}
export interface ProjectInvitationResponse {
  contractVersion: typeof COMMERCIAL_CONTRACT_VERSION_V9;
  responded: true;
  replayed: boolean;
  request_id: string;
}
