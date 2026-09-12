import type { CollaborativeOperationRequest } from '../../lib/commercial/contracts-v8.ts';
import type { StudioContext } from './studio.ts';
import type { WorkerEnvironment } from './types.ts';
import { CommercialRepositoryError } from './types.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';
import { detachedFetch } from './detachedFetch.ts';
import type {
  RealtimeCollaborationTransport,
  CollaborationConnectionContext,
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

const DATABASE_ERRORS: Record<string, [number, string]> = {
  base_version_unavailable: [409, 'base_version_unavailable'],
  client_update_required: [426, 'client_update_required'],
  collaboration_idempotency_conflict: [
    409,
    'collaboration_idempotency_conflict',
  ],
  collaboration_operation_invalid: [400, 'collaboration_operation_invalid'],
  collaboration_scope_invalid: [400, 'collaboration_scope_invalid'],
  studio_device_inactive: [403, 'studio_device_inactive'],
  studio_entitlement_missing: [403, 'studio_entitlement_missing'],
  studio_not_found: [404, 'studio_not_found'],
};

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

/**
 * The channel is updated before the ledger. If the ledger is unavailable, the
 * request fails closed; retrying replays the channel operation and appends the
 * same operation id atomically in Supabase.
 */
export class ReconciledRealtimeTransport implements RealtimeCollaborationTransport {
  constructor(
    private readonly channel: RealtimeCollaborationTransport,
    private readonly ledger: CollaborationLedger,
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

  compact(input: Parameters<RealtimeCollaborationTransport['compact']>[0]) {
    return this.channel.compact(input);
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
