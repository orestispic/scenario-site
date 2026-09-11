export const COMMERCIAL_CONTRACT_VERSION_V6 = '2026-09-v6';

export type ScenarioFormat = 'scenario-v1';
export type ScenarioOrigin = 'save' | 'import' | 'offline_replay' | 'restore';
export type ScenarioAccessRole = 'owner' | 'editor' | 'viewer';
export type SyncQueueState =
  | 'local'
  | 'pending'
  | 'synced'
  | 'conflict'
  | 'failed';

export interface CloudScenarioVersion {
  id: string;
  scenarioId: string;
  authorId: string;
  parentVersionId: string | null;
  versionNumber: number;
  checksum: string;
  sizeBytes: number;
  contentType: 'application/vnd.scenario+json';
  format: ScenarioFormat;
  origin: ScenarioOrigin;
  entitlementSnapshotId: string;
  requestId: string;
  createdAt: string;
}

export interface CloudScenario {
  id: string;
  title: string;
  role: ScenarioAccessRole;
  currentVersionId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudSyncRequest {
  scenarioId: string;
  title: string;
  parentVersionId: string | null;
  checksum: string;
  sizeBytes: number;
  contentType: 'application/vnd.scenario+json';
  format: ScenarioFormat;
  origin: Exclude<ScenarioOrigin, 'restore'>;
  content: string;
}

export interface TemporaryObjectGrant {
  url: string;
  operation: 'download';
  expiresAt: string;
}

export interface CloudSyncResponse {
  contractVersion: '2026-09-v6';
  scenario: CloudScenario;
  version: CloudScenarioVersion;
  replayed: boolean;
  download: TemporaryObjectGrant;
  request_id: string;
}

export interface CloudScenarioListResponse {
  contractVersion: '2026-09-v6';
  scenarios: CloudScenario[];
  request_id: string;
}

export interface CloudVersionListResponse {
  contractVersion: '2026-09-v6';
  versions: CloudScenarioVersion[];
  request_id: string;
}

export interface CloudRestoreRequest {
  versionId: string;
}

export interface CloudConflict {
  code: 'scenario_parent_conflict';
  scenarioId: string;
  localParentVersionId: string | null;
  remoteVersionId: string;
  options: readonly ['keep_local', 'download_remote', 'create_copy'];
}

export interface StudioMembership {
  scenarioId: string;
  profileId: string;
  role: Exclude<ScenarioAccessRole, 'owner'>;
  status: 'invited' | 'active' | 'revoked';
}

export interface CollaborationNotifier {
  membershipChanged(membership: StudioMembership): Promise<void>;
}

export interface CollaborationChannel {
  publishScenarioVersion(scenarioId: string, versionId: string): Promise<void>;
}
