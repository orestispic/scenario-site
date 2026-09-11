export const COMMERCIAL_CONTRACT_VERSION_V8 = '2026-09-v8';
export const COLLABORATION_STRATEGY_V8 = 'scenario-block-lww-v1' as const;

export type CollaborationRole = 'owner' | 'editor' | 'viewer';
export type ConnectionCloseReason =
  | 'client'
  | 'expired'
  | 'idle'
  | 'revoked'
  | 'backpressure'
  | 'capacity'
  | 'channel_unavailable';

export interface CollaborationPresence {
  profileId: string;
  displayName: string;
  role: CollaborationRole;
  connectionCount: number;
  lastHeartbeatAt: string;
}

export interface BlockUpsertMutation {
  type: 'block.upsert';
  blockId: string;
  afterBlockId: string | null;
  block: Record<string, unknown>;
}

export interface BlockDeleteMutation {
  type: 'block.delete';
  blockId: string;
}

export type CollaborativeMutation = BlockUpsertMutation | BlockDeleteMutation;

/** Actor and request id are injected by the authenticated server. */
export interface CollaborativeOperationRequest {
  studioId: string;
  scenarioId: string;
  baseVersionId: string;
  operationId: string;
  clientSequence: number;
  logicalClock: number;
  mutation: CollaborativeMutation;
  checksum: string;
}

export interface CollaborativeOperationRecord extends CollaborativeOperationRequest {
  actorId: string;
  request_id: string;
  cursor: number;
  receivedAt: string;
}

export type CollaborationConflictReason =
  | 'concurrent_same_block'
  | 'stale_tombstone'
  | 'cursor_too_old'
  | 'base_version_unavailable'
  | 'scenario_deleted';

export interface CollaborationConflict {
  id: string;
  operationId: string;
  reason: CollaborationConflictReason;
  winningOperationId: string | null;
  recovery: Array<'keep_local' | 'accept_remote' | 'create_copy'>;
  createdAt: string;
}

export type CollaborationEvent =
  | {
      cursor: number;
      type: 'presence.changed';
      presence: CollaborationPresence[];
    }
  | {
      cursor: number;
      type: 'operation.applied';
      operation: CollaborativeOperationRecord;
    }
  | {
      cursor: number;
      type: 'operation.conflict';
      conflict: CollaborationConflict;
    }
  | {
      cursor: number;
      type: 'snapshot.created';
      snapshotId: string;
      versionId: string;
    }
  | {
      cursor: number;
      type: 'connection.closed';
      profileId: string;
      reason: ConnectionCloseReason;
    };

export interface CollaborationLimits {
  heartbeatIntervalSeconds: number;
  idleTimeoutSeconds: number;
  maximumConnectionSeconds: number;
  maximumOperationBytes: number;
  maximumPendingEvents: number;
  reconnectBackoffMaximumSeconds: number;
}

export interface CollaborationTicketResponse {
  contractVersion: '2026-09-v8';
  ticket: string;
  expiresAt: string;
  maximumUses: 1;
  request_id: string;
}

export interface CollaborationConnectionResponse {
  contractVersion: '2026-09-v8';
  connectionId: string;
  studioId: string;
  scenarioId: string;
  role: CollaborationRole;
  cursor: number;
  presence: CollaborationPresence[];
  limits: CollaborationLimits;
  request_id: string;
}

export interface CollaborationPollResponse {
  contractVersion: '2026-09-v8';
  events: CollaborationEvent[];
  nextCursor: number;
  hasMore: boolean;
  syncLag: number;
  request_id: string;
}

export interface CollaborationOperationResponse {
  contractVersion: '2026-09-v8';
  status: 'applied' | 'replayed' | 'conflict';
  operation?: CollaborativeOperationRecord;
  conflict?: CollaborationConflict;
  nextCursor: number;
  request_id: string;
}

export interface CollaborationSnapshotResponse {
  contractVersion: '2026-09-v8';
  snapshotId: string;
  versionId: string;
  parentVersionId: string;
  cursor: number;
  checksum: string;
  replayed: boolean;
  request_id: string;
}

export interface CollaborationRecoveryCopy {
  format: 'scenario-collaboration-recovery-v1';
  studioId: string;
  scenarioId: string;
  baseVersionId: string;
  operations: CollaborativeOperationRequest[];
  createdAt: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function envelope(value: unknown): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    value.contractVersion !== COMMERCIAL_CONTRACT_VERSION_V8 ||
    typeof value.request_id !== 'string'
  )
    throw new Error('Réponse collaborative v8 invalide.');
}
function presence(value: unknown): value is CollaborationPresence {
  return (
    record(value) &&
    typeof value.profileId === 'string' &&
    typeof value.displayName === 'string' &&
    ['owner', 'editor', 'viewer'].includes(String(value.role)) &&
    Number.isSafeInteger(value.connectionCount) &&
    typeof value.lastHeartbeatAt === 'string'
  );
}
export function parseCollaborationTicketResponse(
  value: unknown,
): CollaborationTicketResponse {
  envelope(value);
  if (
    typeof value.ticket !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    value.maximumUses !== 1
  )
    throw new Error('Ticket collaboratif invalide.');
  return value as unknown as CollaborationTicketResponse;
}
export function parseCollaborationConnectionResponse(
  value: unknown,
): CollaborationConnectionResponse {
  envelope(value);
  if (
    typeof value.connectionId !== 'string' ||
    typeof value.studioId !== 'string' ||
    typeof value.scenarioId !== 'string' ||
    !['owner', 'editor', 'viewer'].includes(String(value.role)) ||
    !Number.isSafeInteger(value.cursor) ||
    !Array.isArray(value.presence) ||
    value.presence.some((item) => !presence(item)) ||
    !record(value.limits)
  )
    throw new Error('Connexion collaborative invalide.');
  return value as unknown as CollaborationConnectionResponse;
}
export function parseCollaborationPollResponse(
  value: unknown,
): CollaborationPollResponse {
  envelope(value);
  if (
    !Array.isArray(value.events) ||
    !Number.isSafeInteger(value.nextCursor) ||
    typeof value.hasMore !== 'boolean' ||
    !Number.isSafeInteger(value.syncLag)
  )
    throw new Error('Rattrapage collaboratif invalide.');
  return value as unknown as CollaborationPollResponse;
}
export function parseCollaborationOperationResponse(
  value: unknown,
): CollaborationOperationResponse {
  envelope(value);
  if (
    !['applied', 'replayed', 'conflict'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.nextCursor)
  )
    throw new Error('Opération collaborative invalide.');
  return value as unknown as CollaborationOperationResponse;
}
export function parseCollaborationSnapshotResponse(
  value: unknown,
): CollaborationSnapshotResponse {
  envelope(value);
  if (
    typeof value.snapshotId !== 'string' ||
    typeof value.versionId !== 'string' ||
    typeof value.parentVersionId !== 'string' ||
    !Number.isSafeInteger(value.cursor) ||
    typeof value.checksum !== 'string' ||
    typeof value.replayed !== 'boolean'
  )
    throw new Error('Snapshot collaboratif invalide.');
  return value as unknown as CollaborationSnapshotResponse;
}
