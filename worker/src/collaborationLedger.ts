import type {
  CollaborationSnapshotResponse,
  CollaborativeOperationRequest,
} from '../../lib/commercial/contracts-v8.ts';
import {
  CLOUD_CONTENT_TYPE,
  type CloudScenarioRepository,
  type ScenarioObjectStorage,
} from './cloudSync.ts';
import type { StudioContext } from './studio.ts';
import type { WorkerEnvironment } from './types.ts';
import { CommercialRepositoryError } from './types.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';
import { detachedFetch } from './detachedFetch.ts';
import type {
  RealtimeCollaborationTransport,
  CollaborationConnectionContext,
  CollaborationSnapshotArtifact,
} from './realtimeCollaboration.ts';

type LedgerContext = CollaborationConnectionContext & {
  studioId: string;
  requestId: string;
};

export interface CollaborationLedger {
  appendOperation(
    input: LedgerContext & { operation: CollaborativeOperationRequest },
  ): Promise<{ status: 'applied' | 'replayed' | 'conflict'; cursor: number }>;
  acknowledgeOperations(
    input: LedgerContext & { operationIds: string[] },
  ): Promise<number | null>;
}

export interface CollaborationSnapshotPersistence {
  persist(
    input: LedgerContext & {
      connectionId: string;
      idempotencyHash: string;
      parentVersionId: string;
      channel: Omit<
        CollaborationSnapshotResponse,
        'contractVersion' | 'request_id'
      >;
      artifact: CollaborationSnapshotArtifact;
    },
  ): Promise<
    Omit<CollaborationSnapshotResponse, 'contractVersion' | 'request_id'>
  >;
  verifySnapshots(
    input: LedgerContext & { snapshotIds: string[] },
  ): Promise<void>;
}

const DATABASE_ERRORS: Record<string, [number, string]> = {
  base_version_unavailable: [409, 'base_version_unavailable'],
  client_update_required: [426, 'client_update_required'],
  collaboration_idempotency_conflict: [
    409,
    'collaboration_idempotency_conflict',
  ],
  collaboration_operation_invalid: [400, 'collaboration_operation_invalid'],
  collaboration_scope_invalid: [400, 'collaboration_scope_invalid'],
  collaboration_snapshot_invalid: [400, 'collaboration_snapshot_invalid'],
  collaboration_snapshot_stale: [409, 'collaboration_snapshot_stale'],
  collaboration_ledger_incomplete: [503, 'collaboration_ledger_incomplete'],
  scenario_parent_conflict: [409, 'scenario_parent_conflict'],
  studio_device_inactive: [403, 'studio_device_inactive'],
  studio_entitlement_missing: [403, 'studio_entitlement_missing'],
  studio_not_found: [404, 'studio_not_found'],
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const result = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function blockId(value: unknown): string | null {
  if (!record(value) || !record(value.attrs)) return null;
  return typeof value.attrs.blockId === 'string' && value.attrs.blockId
    ? value.attrs.blockId
    : null;
}

export function mergeCollaborationSnapshot(
  parentBytes: Uint8Array,
  artifact: CollaborationSnapshotArtifact,
): Uint8Array {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(parentBytes));
  } catch {
    throw new CommercialRepositoryError(
      409,
      'collaboration_parent_invalid',
      'Version parente invalide.',
    );
  }
  if (!record(document) || document.formatVersion !== 1)
    throw new CommercialRepositoryError(
      409,
      'collaboration_parent_invalid',
      'Version parente invalide.',
    );
  const editorContent = record(document.content) ? document.content : null;
  const editor = editorContent?.type === 'doc';
  const original = editor
    ? editorContent.content
    : Array.isArray(document.blocks)
      ? document.blocks
      : [];
  if (!Array.isArray(original))
    throw new CommercialRepositoryError(
      409,
      'collaboration_parent_invalid',
      'Version parente invalide.',
    );
  const blocks = structuredClone(original);
  const ordered = [...artifact.entries].sort((left, right) => {
    const a = `${String(left.logicalClock).padStart(16, '0')}:${left.actorId}:${left.operationId}`;
    const b = `${String(right.logicalClock).padStart(16, '0')}:${right.actorId}:${right.operationId}`;
    return a.localeCompare(b);
  });
  for (const entry of ordered) {
    const current = blocks.findIndex(
      (block) => blockId(block) === entry.blockId,
    );
    if (current >= 0) blocks.splice(current, 1);
    if (entry.tombstone) continue;
    if (entry.mutation.type === 'block.delete') continue;
    const mutation = entry.mutation;
    const after =
      mutation.afterBlockId === null
        ? -1
        : blocks.findIndex((block) => blockId(block) === mutation.afterBlockId);
    blocks.splice(
      after < 0 && mutation.afterBlockId !== null ? blocks.length : after + 1,
      0,
      structuredClone(mutation.block),
    );
  }
  if (editor) (document.content as Record<string, unknown>).content = blocks;
  else document.blocks = blocks;
  return new TextEncoder().encode(canonical(document));
}

/** Supabase append-only ledger; it never receives a ticket or connection id. */
export class SupabaseCollaborationLedger implements CollaborationLedger {
  constructor(
    private readonly environment: WorkerEnvironment,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  appendOperation(
    input: LedgerContext & { operation: CollaborativeOperationRequest },
  ) {
    const operation = input.operation;
    return this.rpc<{
      status: 'applied' | 'replayed' | 'conflict';
      cursor: number;
    }>('append_studio_collaboration_operation', {
      ...this.context(input.context),
      p_studio_id: input.studioId,
      p_scenario_id: operation.scenarioId,
      p_base_version_id: operation.baseVersionId,
      p_operation_id: operation.operationId,
      p_client_sequence: operation.clientSequence,
      p_logical_clock: operation.logicalClock,
      p_operation_type: operation.mutation.type,
      p_block_id: operation.mutation.blockId,
      p_mutation: operation.mutation,
      p_checksum: operation.checksum,
      p_request_id: input.requestId,
    });
  }

  async acknowledgeOperations(
    input: LedgerContext & { operationIds: string[] },
  ) {
    const operationIds = [...new Set(input.operationIds)];
    if (operationIds.length === 0) return null;
    const query = new URLSearchParams({
      studio_id: `eq.${input.studioId}`,
      operation_id: `in.(${operationIds.join(',')})`,
      select: 'operation_id,cursor',
    });
    const response = await detachedFetch(
      this.fetcher,
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/studio_collaboration_operations?${query}`,
      { headers: supabaseAdminHeaders(this.environment) },
    );
    if (!response.ok)
      throw new CommercialRepositoryError(
        503,
        'collaboration_ledger_unavailable',
        'Journal collaboratif temporairement indisponible.',
      );
    const rows = (await response.json()) as Array<{
      operation_id: string;
      cursor: number;
    }>;
    if (
      rows.length !== operationIds.length ||
      rows.some(
        (row) =>
          !operationIds.includes(row.operation_id) ||
          !Number.isSafeInteger(Number(row.cursor)),
      )
    )
      throw new CommercialRepositoryError(
        503,
        'collaboration_ledger_incomplete',
        'Rattrapage collaboratif en attente de réconciliation.',
      );
    const cursor = Math.max(...rows.map((row) => Number(row.cursor)));
    await this.rpc<number>('ack_studio_collaboration_cursor', {
      ...this.context(input.context),
      p_studio_id: input.studioId,
      p_cursor: cursor,
    });
    return cursor;
  }

  private context(value: StudioContext) {
    return {
      p_profile_id: value.profileId,
      p_fingerprint_hash: value.fingerprintHash,
      p_platform: value.platform,
      p_client_version: value.clientVersion,
    };
  }

  private async rpc<T>(name: string, body: unknown): Promise<T> {
    const response = await detachedFetch(
      this.fetcher,
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`,
      {
        method: 'POST',
        headers: {
          ...supabaseAdminHeaders(this.environment),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      const match = Object.entries(DATABASE_ERRORS).find(([key]) =>
        text.includes(key),
      );
      if (match)
        throw new CommercialRepositoryError(
          match[1][0],
          match[1][1],
          'Persistance collaborative refusée.',
        );
      throw new CommercialRepositoryError(
        503,
        'collaboration_ledger_unavailable',
        'Journal collaboratif temporairement indisponible.',
      );
    }
    return response.json() as Promise<T>;
  }
}

export class SupabaseCollaborationSnapshotPersistence implements CollaborationSnapshotPersistence {
  constructor(
    private readonly environment: WorkerEnvironment,
    private readonly cloud: CloudScenarioRepository,
    private readonly storage: ScenarioObjectStorage,
    private readonly storageKeyPepper: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async persist(
    input: Parameters<CollaborationSnapshotPersistence['persist']>[0],
  ) {
    if (
      input.artifact.snapshotId !== input.channel.snapshotId ||
      input.artifact.versionId !== input.channel.versionId ||
      input.artifact.parentVersionId !== input.parentVersionId ||
      input.artifact.channelCursor !== input.channel.cursor
    )
      throw new CommercialRepositoryError(
        409,
        'collaboration_snapshot_mismatch',
        'Snapshot du canal incohérent.',
      );
    const cloudContext = {
      profileId: input.context.profileId,
      fingerprintHash: input.context.fingerprintHash,
      platform: input.context.platform,
      clientVersion: input.context.clientVersion,
    };
    const scenarios = await this.cloud.list(cloudContext);
    const scenario = scenarios.find(
      (candidate) => candidate.id === input.authorization?.scenarioId,
    );
    if (!scenario || scenario.currentVersionId !== input.parentVersionId)
      throw new CommercialRepositoryError(
        409,
        'scenario_parent_conflict',
        'Une version distante plus récente existe.',
      );
    const parentKey = await this.cloud.storageKey(
      cloudContext,
      scenario.id,
      input.parentVersionId,
    );
    const parentBytes = await this.storage.get(parentKey);
    const snapshotBytes = mergeCollaborationSnapshot(
      parentBytes,
      input.artifact,
    );
    const checksum = await sha256(snapshotBytes);
    const accountScope = await hmac(
      input.context.profileId,
      this.storageKeyPepper,
    );
    const storageKey = `${accountScope}/scenarios/${scenario.id}/snapshots/${input.channel.snapshotId}.scenario`;
    await this.storage.put({
      key: storageKey,
      bytes: snapshotBytes,
      contentType: CLOUD_CONTENT_TYPE,
      checksum,
    });
    const throughCursor = await this.operationCursor(
      input.studioId,
      input.artifact.operationIds,
    );
    const persisted = await this.rpc<{ replayed: boolean }>(
      'commit_studio_collaboration_snapshot_v2',
      {
        ...this.context(input.context),
        p_studio_id: input.studioId,
        p_snapshot_id: input.channel.snapshotId,
        p_version_id: input.channel.versionId,
        p_parent_version_id: input.parentVersionId,
        p_through_cursor: throughCursor,
        p_storage_key: storageKey,
        p_checksum: checksum,
        p_size_bytes: snapshotBytes.byteLength,
        p_title: scenario.title,
        p_idempotency_hash: input.idempotencyHash,
        p_request_id: input.requestId,
      },
    );
    return {
      snapshotId: input.channel.snapshotId,
      versionId: input.channel.versionId,
      parentVersionId: input.parentVersionId,
      cursor: input.channel.cursor,
      checksum,
      replayed: persisted.replayed,
    };
  }

  async verifySnapshots(
    input: Parameters<CollaborationSnapshotPersistence['verifySnapshots']>[0],
  ) {
    const snapshotIds = [...new Set(input.snapshotIds)];
    if (snapshotIds.length === 0) return;
    const rows = await this.rows(
      'studio_collaboration_snapshots',
      input.studioId,
      'id',
      snapshotIds,
      'id',
    );
    if (
      rows.length !== snapshotIds.length ||
      rows.some((row) => !snapshotIds.includes(String(row.id)))
    )
      throw new CommercialRepositoryError(
        503,
        'collaboration_snapshot_pending',
        'Snapshot en attente de persistance.',
      );
  }

  private context(value: StudioContext) {
    return {
      p_profile_id: value.profileId,
      p_fingerprint_hash: value.fingerprintHash,
      p_platform: value.platform,
      p_client_version: value.clientVersion,
    };
  }

  private async operationCursor(studioId: string, operationIds: string[]) {
    const unique = [...new Set(operationIds)];
    if (unique.length === 0) return 0;
    const rows = await this.rows(
      'studio_collaboration_operations',
      studioId,
      'operation_id',
      unique,
      'operation_id,cursor',
    );
    if (
      rows.length !== unique.length ||
      rows.some(
        (row) =>
          !unique.includes(String(row.operation_id)) ||
          !Number.isSafeInteger(Number(row.cursor)),
      )
    )
      throw new CommercialRepositoryError(
        503,
        'collaboration_ledger_incomplete',
        'Snapshot en attente de réconciliation.',
      );
    return Math.max(...rows.map((row) => Number(row.cursor)));
  }

  private async rows(
    table: string,
    studioId: string,
    identityColumn: string,
    identities: string[],
    select: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < identities.length; offset += 100) {
      const batch = identities.slice(offset, offset + 100);
      const query = new URLSearchParams({
        studio_id: `eq.${studioId}`,
        [identityColumn]: `in.(${batch.join(',')})`,
        select,
      });
      const response = await detachedFetch(
        this.fetcher,
        `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?${query}`,
        { headers: supabaseAdminHeaders(this.environment) },
      );
      if (!response.ok)
        throw new CommercialRepositoryError(
          503,
          'collaboration_ledger_unavailable',
          'Journal collaboratif temporairement indisponible.',
        );
      const batchRows = (await response.json()) as Array<
        Record<string, unknown>
      >;
      rows.push(...batchRows);
    }
    return rows;
  }

  private async rpc<T>(name: string, body: unknown): Promise<T> {
    const response = await detachedFetch(
      this.fetcher,
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`,
      {
        method: 'POST',
        headers: {
          ...supabaseAdminHeaders(this.environment),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      const match = Object.entries(DATABASE_ERRORS).find(([key]) =>
        text.includes(key),
      );
      if (match)
        throw new CommercialRepositoryError(
          match[1][0],
          match[1][1],
          'Persistance du snapshot refusée.',
        );
      throw new CommercialRepositoryError(
        503,
        'collaboration_snapshot_unavailable',
        'Persistance du snapshot indisponible.',
      );
    }
    return response.json() as Promise<T>;
  }
}

/**
 * The channel is updated before the ledger. If the ledger is unavailable, the
 * request fails closed; retrying replays the channel operation and appends the
 * same operation id atomically in Supabase.
 */
export class ReconciledRealtimeTransport implements RealtimeCollaborationTransport {
  constructor(
    private readonly channel: RealtimeCollaborationTransport,
    private readonly ledger: CollaborationLedger,
    private readonly snapshots?: CollaborationSnapshotPersistence,
  ) {}

  issueTicket(
    input: Parameters<RealtimeCollaborationTransport['issueTicket']>[0],
  ) {
    return this.channel.issueTicket(input);
  }

  connect(input: Parameters<RealtimeCollaborationTransport['connect']>[0]) {
    return this.channel.connect(input);
  }

  heartbeat(input: Parameters<RealtimeCollaborationTransport['heartbeat']>[0]) {
    return this.channel.heartbeat(input);
  }

  async poll(input: Parameters<RealtimeCollaborationTransport['poll']>[0]) {
    const result = await this.channel.poll(input);
    await this.ledger.acknowledgeOperations({
      context: input.context,
      origin: input.origin,
      authorization: input.authorization,
      studioId: input.studioId,
      requestId: input.requestId,
      operationIds: result.events.flatMap((event) =>
        event.type === 'operation.applied' ? [event.operation.operationId] : [],
      ),
    });
    await this.snapshots?.verifySnapshots({
      context: input.context,
      origin: input.origin,
      authorization: input.authorization,
      studioId: input.studioId,
      requestId: input.requestId,
      snapshotIds: result.events.flatMap((event) =>
        event.type === 'snapshot.created' ? [event.snapshotId] : [],
      ),
    });
    return result;
  }

  async submit(input: Parameters<RealtimeCollaborationTransport['submit']>[0]) {
    const result = await this.channel.submit(input);
    await this.ledger.appendOperation({
      context: input.context,
      origin: input.origin,
      authorization: input.authorization,
      studioId: input.studioId,
      requestId: input.requestId,
      operation: input.operation,
    });
    return result;
  }

  async compact(
    input: Parameters<RealtimeCollaborationTransport['compact']>[0],
  ) {
    const result = await this.channel.compact(input);
    if (!this.snapshots) return result;
    if (!this.channel.snapshotArtifact)
      throw new CommercialRepositoryError(
        503,
        'collaboration_snapshot_unavailable',
        'Artefact de compaction indisponible.',
      );
    const artifact = await this.channel.snapshotArtifact({
      context: input.context,
      origin: input.origin,
      authorization: input.authorization,
      studioId: input.studioId,
      connectionId: input.connectionId,
      snapshotId: result.snapshotId,
      requestId: input.requestId,
    });
    return this.snapshots.persist({
      context: input.context,
      origin: input.origin,
      authorization: input.authorization,
      studioId: input.studioId,
      requestId: input.requestId,
      connectionId: input.connectionId,
      idempotencyHash: input.idempotencyHash,
      parentVersionId: input.parentVersionId,
      channel: result,
      artifact,
    });
  }

  disconnect(
    input: Parameters<RealtimeCollaborationTransport['disconnect']>[0],
  ) {
    return this.channel.disconnect(input);
  }

  revokeProfile(
    profileId: string,
    reason?: Parameters<RealtimeCollaborationTransport['revokeProfile']>[1],
  ) {
    return this.channel.revokeProfile(profileId, reason);
  }

  revokeStudioMember(
    studioId: string,
    profileId: string,
    reason?: Parameters<
      RealtimeCollaborationTransport['revokeStudioMember']
    >[2],
  ) {
    return this.channel.revokeStudioMember(studioId, profileId, reason);
  }
}
