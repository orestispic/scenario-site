import type {
  CollaborationConflict,
  CollaborationEvent,
  CollaborationLimits,
  CollaborationOperationResponse,
  CollaborationPresence,
  CollaborationRole,
  CollaborationSnapshotResponse,
  CollaborativeOperationRecord,
  CollaborativeOperationRequest,
  ConnectionCloseReason,
} from '../../lib/commercial/contracts-v8.ts';
import type { StudioContext, StudioRepository } from './studio.ts';
import { CommercialRepositoryError } from './types.ts';

export interface RealtimePolicy extends CollaborationLimits {
  ticketTtlSeconds: number;
  maximumConnectionsPerStudio: number;
  maximumConnectionsPerProfile: number;
  maximumEventsPerPoll: number;
  tombstoneRetentionOperations: number;
}

export interface CollaborationConnectionContext {
  context: StudioContext;
  origin: string;
  authorization?: {
    scenarioId: string;
    role: CollaborationRole;
  };
}

export interface RealtimeCollaborationTransport {
  issueTicket(
    input: CollaborationConnectionContext & {
      studioId: string;
      requestId: string;
    },
  ): Promise<{
    ticket: string;
    expiresAt: string;
    maximumUses: 1;
  }>;
  connect(
    input: CollaborationConnectionContext & {
      studioId: string;
      ticket: string;
      afterCursor: number;
      requestId: string;
    },
  ): Promise<{
    connectionId: string;
    studioId: string;
    scenarioId: string;
    role: CollaborationRole;
    cursor: number;
    presence: CollaborationPresence[];
    limits: CollaborationLimits;
  }>;
  heartbeat(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      requestId: string;
    },
  ): Promise<{ cursor: number; presence: CollaborationPresence[] }>;
  poll(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      afterCursor: number;
      requestId: string;
    },
  ): Promise<{
    events: CollaborationEvent[];
    nextCursor: number;
    hasMore: boolean;
    syncLag: number;
  }>;
  submit(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      operation: CollaborativeOperationRequest;
      requestId: string;
    },
  ): Promise<
    Omit<CollaborationOperationResponse, 'contractVersion' | 'request_id'>
  >;
  compact(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      parentVersionId: string;
      idempotencyHash: string;
      requestId: string;
    },
  ): Promise<
    Omit<CollaborationSnapshotResponse, 'contractVersion' | 'request_id'>
  >;
  disconnect(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      requestId: string;
    },
  ): Promise<void>;
  revokeProfile(
    profileId: string,
    reason?: ConnectionCloseReason,
  ): Promise<void>;
  revokeStudioMember(
    studioId: string,
    profileId: string,
    reason?: ConnectionCloseReason,
  ): Promise<void>;
}

export interface CollaborationChannelNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/**
 * Production bridge for a Cloudflare Durable Object (or API-compatible channel).
 * Authorization is still performed by the Worker before each call; the channel
 * receives no bearer/session token and logs must treat its body as sensitive.
 */
export class CloudflareRealtimeTransport implements RealtimeCollaborationTransport {
  constructor(private readonly namespace: CollaborationChannelNamespace) {}
  private async call<T>(
    studioId: string,
    command: string,
    body: unknown,
  ): Promise<T> {
    const stub = this.namespace.get(this.namespace.idFromName(studioId));
    const response = await stub.fetch(
      new Request('https://studio-channel.invalid/internal', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-command': command },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) {
      const payload = await response
        .json<{ code?: unknown }>()
        .catch(() => null);
      const code =
        typeof payload?.code === 'string' &&
        /^[a-z][a-z0-9_]{0,63}$/.test(payload.code)
          ? payload.code
          : 'channel_unavailable';
      throw new CommercialRepositoryError(
        response.status,
        code,
        'Canal collaboratif indisponible.',
      );
    }
    return response.json() as Promise<T>;
  }
  issueTicket(
    input: Parameters<RealtimeCollaborationTransport['issueTicket']>[0],
  ) {
    return this.call<
      Awaited<ReturnType<RealtimeCollaborationTransport['issueTicket']>>
    >(input.studioId, 'ticket', input);
  }
  connect(input: Parameters<RealtimeCollaborationTransport['connect']>[0]) {
    return this.call<
      Awaited<ReturnType<RealtimeCollaborationTransport['connect']>>
    >(input.studioId, 'connect', input);
  }
  heartbeat(input: Parameters<RealtimeCollaborationTransport['heartbeat']>[0]) {
    return this.call<
      Awaited<ReturnType<RealtimeCollaborationTransport['heartbeat']>>
    >(input.studioId, 'heartbeat', input);
  }
  poll(input: Parameters<RealtimeCollaborationTransport['poll']>[0]) {
    return this.call<
      Awaited<ReturnType<RealtimeCollaborationTransport['poll']>>
    >(input.studioId, 'poll', input);
  }
  submit(input: Parameters<RealtimeCollaborationTransport['submit']>[0]) {
    return this.call<
      Awaited<ReturnType<RealtimeCollaborationTransport['submit']>>
    >(input.studioId, 'submit', input);
  }
  compact(input: Parameters<RealtimeCollaborationTransport['compact']>[0]) {
    return this.call<
      Awaited<ReturnType<RealtimeCollaborationTransport['compact']>>
    >(input.studioId, 'compact', input);
  }
  async disconnect(
    input: Parameters<RealtimeCollaborationTransport['disconnect']>[0],
  ) {
    await this.call(input.studioId, 'disconnect', input);
  }
  async revokeProfile(
    profileId: string,
    reason: ConnectionCloseReason = 'revoked',
  ) {
    await this.call('global', 'revoke-profile', { profileId, reason });
  }
  async revokeStudioMember(
    studioId: string,
    profileId: string,
    reason: ConnectionCloseReason = 'revoked',
  ) {
    await this.call(studioId, 'revoke-member', { studioId, profileId, reason });
  }
}

type Ticket = {
  hash: string;
  studioId: string;
  scenarioId: string;
  profileId: string;
  fingerprintHash: string;
  origin: string;
  role: CollaborationRole;
  expiresAt: number;
  used: boolean;
};
type Connection = {
  id: string;
  studioId: string;
  scenarioId: string;
  profileId: string;
  displayName: string;
  fingerprintHash: string;
  origin: string;
  role: CollaborationRole;
  connectedAt: number;
  heartbeatAt: number;
  ackCursor: number;
};
type Register = { operation: CollaborativeOperationRecord; tombstone: boolean };
type Channel = {
  cursor: number;
  minimumCursor: number;
  events: CollaborationEvent[];
  operations: Map<string, CollaborativeOperationRecord>;
  blocks: Map<string, Register>;
  conflicts: CollaborationConflict[];
  snapshots: Array<
    Omit<CollaborationSnapshotResponse, 'contractVersion' | 'request_id'>
  >;
  compactions: Map<
    string,
    Omit<CollaborationSnapshotResponse, 'contractVersion' | 'request_id'>
  >;
};

export type DurableRealtimeState = {
  tickets: Ticket[];
  channels: Array<{
    studioId: string;
    cursor: number;
    minimumCursor: number;
    events: CollaborationEvent[];
    operations: Array<[string, CollaborativeOperationRecord]>;
    blocks: Array<[string, Register]>;
    conflicts: CollaborationConflict[];
    snapshots: Array<
      Omit<CollaborationSnapshotResponse, 'contractVersion' | 'request_id'>
    >;
    compactions: Array<
      [
        string,
        Omit<CollaborationSnapshotResponse, 'contractVersion' | 'request_id'>,
      ]
    >;
  }>;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
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
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
export async function collaborativeOperationChecksum(
  operation: Omit<CollaborativeOperationRequest, 'checksum'>,
): Promise<string> {
  return sha256(canonical(operation));
}
function tuple(record: CollaborativeOperationRecord): string {
  return `${String(record.logicalClock).padStart(16, '0')}:${record.actorId}:${record.operationId}`;
}

export class DeterministicLocalRealtimeTransport implements RealtimeCollaborationTransport {
  private readonly tickets = new Map<string, Ticket>();
  private readonly connections = new Map<string, Connection>();
  private readonly channels = new Map<string, Channel>();
  readonly audit: Array<{
    action: string;
    studioId: string;
    requestId: string;
    cursor?: number;
  }> = [];

  constructor(
    private readonly studios: StudioRepository,
    private readonly secret: string,
    readonly policy: RealtimePolicy,
    private readonly now: () => number = Date.now,
  ) {}

  restoreDurableState(state: DurableRealtimeState | undefined): void {
    if (!state) return;
    this.tickets.clear();
    for (const ticket of state.tickets)
      if (!ticket.used && ticket.expiresAt > this.now())
        this.tickets.set(ticket.hash, structuredClone(ticket));
    this.channels.clear();
    for (const value of state.channels)
      this.channels.set(value.studioId, {
        cursor: value.cursor,
        minimumCursor: value.minimumCursor,
        events: structuredClone(value.events),
        operations: new Map(structuredClone(value.operations)),
        blocks: new Map(structuredClone(value.blocks)),
        conflicts: structuredClone(value.conflicts),
        snapshots: structuredClone(value.snapshots),
        compactions: new Map(structuredClone(value.compactions)),
      });
  }

  durableState(): DurableRealtimeState {
    this.sweep();
    return {
      tickets: [...this.tickets.values()].map((value) =>
        structuredClone(value),
      ),
      channels: [...this.channels.entries()].map(([studioId, value]) => ({
        studioId,
        cursor: value.cursor,
        minimumCursor: value.minimumCursor,
        events: value.events
          .filter((event) => event.type !== 'presence.changed')
          .map((event) => structuredClone(event)),
        operations: [...value.operations.entries()].map(([key, item]) => [
          key,
          structuredClone(item),
        ]),
        blocks: [...value.blocks.entries()].map(([key, item]) => [
          key,
          structuredClone(item),
        ]),
        conflicts: structuredClone(value.conflicts),
        snapshots: structuredClone(value.snapshots),
        compactions: [...value.compactions.entries()].map(([key, item]) => [
          key,
          structuredClone(item),
        ]),
      })),
    };
  }

  async issueTicket(
    input: CollaborationConnectionContext & {
      studioId: string;
      requestId: string;
    },
  ) {
    this.sweep();
    const access = await this.studios.authorizeRealtime(
      input.context,
      input.studioId,
      false,
    );
    const raw = `${crypto.randomUUID()}.${await hmac(`${input.context.profileId}:${input.studioId}:${input.context.fingerprintHash}:${input.origin}:${crypto.randomUUID()}`, this.secret)}`;
    const hash = await sha256(raw);
    const expiresAt = this.now() + this.policy.ticketTtlSeconds * 1_000;
    this.tickets.set(hash, {
      hash,
      studioId: input.studioId,
      scenarioId: access.scenarioId,
      profileId: input.context.profileId,
      fingerprintHash: input.context.fingerprintHash,
      origin: input.origin,
      role: access.role,
      expiresAt,
      used: false,
    });
    this.audit.push({
      action: 'ticket.issued',
      studioId: input.studioId,
      requestId: input.requestId,
    });
    return {
      ticket: raw,
      expiresAt: new Date(expiresAt).toISOString(),
      maximumUses: 1 as const,
    };
  }

  async connect(
    input: CollaborationConnectionContext & {
      studioId: string;
      ticket: string;
      afterCursor: number;
      requestId: string;
    },
  ) {
    this.sweep();
    const hash = await sha256(input.ticket);
    const ticket = this.tickets.get(hash);
    if (
      !ticket ||
      ticket.used ||
      ticket.expiresAt <= this.now() ||
      ticket.studioId !== input.studioId ||
      ticket.profileId !== input.context.profileId ||
      ticket.fingerprintHash !== input.context.fingerprintHash ||
      ticket.origin !== input.origin
    )
      throw new CommercialRepositoryError(
        401,
        'collaboration_ticket_invalid',
        'Ticket collaboratif invalide ou expiré.',
      );
    const access = await this.studios.authorizeRealtime(
      input.context,
      input.studioId,
      false,
    );
    const studioConnections = [...this.connections.values()].filter(
      (value) => value.studioId === input.studioId,
    );
    if (
      studioConnections.length >= this.policy.maximumConnectionsPerStudio ||
      studioConnections.filter(
        (value) => value.profileId === input.context.profileId,
      ).length >= this.policy.maximumConnectionsPerProfile
    )
      throw new CommercialRepositoryError(
        429,
        'collaboration_capacity_reached',
        'Capacité collaborative atteinte.',
      );
    const channel = this.channel(input.studioId);
    if (input.afterCursor < channel.minimumCursor)
      throw new CommercialRepositoryError(
        409,
        'collaboration_cursor_too_old',
        'Le curseur nécessite une récupération explicite.',
      );
    ticket.used = true;
    const connection: Connection = {
      id: crypto.randomUUID(),
      studioId: input.studioId,
      scenarioId: access.scenarioId,
      profileId: input.context.profileId,
      displayName: input.context.displayName,
      fingerprintHash: input.context.fingerprintHash,
      origin: input.origin,
      role: access.role,
      connectedAt: this.now(),
      heartbeatAt: this.now(),
      ackCursor: input.afterCursor,
    };
    this.connections.set(connection.id, connection);
    this.presenceEvent(input.studioId);
    this.audit.push({
      action: 'connection.opened',
      studioId: input.studioId,
      requestId: input.requestId,
    });
    return {
      connectionId: connection.id,
      studioId: input.studioId,
      scenarioId: access.scenarioId,
      role: access.role,
      cursor: input.afterCursor,
      presence: this.presence(input.studioId),
      limits: this.publicLimits(),
    };
  }

  async heartbeat(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      requestId: string;
    },
  ) {
    this.sweep();
    const connection = await this.requireConnection(input, false);
    connection.heartbeatAt = this.now();
    connection.role = (
      await this.studios.authorizeRealtime(input.context, input.studioId, false)
    ).role;
    return {
      cursor: this.channel(input.studioId).cursor,
      presence: this.presence(input.studioId),
    };
  }

  async poll(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      afterCursor: number;
      requestId: string;
    },
  ) {
    this.sweep();
    const connection = await this.requireConnection(input, false);
    const channel = this.channel(input.studioId);
    if (input.afterCursor < channel.minimumCursor) {
      this.close(connection, 'revoked', input.requestId);
      throw new CommercialRepositoryError(
        409,
        'collaboration_cursor_too_old',
        'Le curseur nécessite une copie ou un snapshot.',
      );
    }
    if (channel.cursor - input.afterCursor > this.policy.maximumPendingEvents) {
      this.close(connection, 'backpressure', input.requestId);
      throw new CommercialRepositoryError(
        429,
        'collaboration_backpressure',
        'Rattrapage trop volumineux.',
      );
    }
    connection.ackCursor = Math.max(connection.ackCursor, input.afterCursor);
    const available = channel.events.filter(
      (event) =>
        event.type !== 'presence.changed' && event.cursor > input.afterCursor,
    );
    const events = available
      .slice(0, this.policy.maximumEventsPerPoll)
      .map((event) => structuredClone(event));
    const nextCursor = events.at(-1)?.cursor ?? input.afterCursor;
    return {
      events,
      nextCursor,
      hasMore: available.length > events.length,
      syncLag: Math.max(0, channel.cursor - nextCursor),
    };
  }

  async submit(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      operation: CollaborativeOperationRequest;
      requestId: string;
    },
  ) {
    this.sweep();
    const connection = await this.requireConnection(input, true);
    if (connection.role === 'viewer')
      throw new CommercialRepositoryError(
        403,
        'studio_write_forbidden',
        'Écriture Studio refusée.',
      );
    if (
      input.operation.studioId !== input.studioId ||
      input.operation.scenarioId !== connection.scenarioId
    )
      throw new CommercialRepositoryError(
        400,
        'collaboration_scope_invalid',
        'Portée collaborative invalide.',
      );
    const channel = this.channel(input.studioId);
    const previous = channel.operations.get(input.operation.operationId);
    if (previous) {
      if (previous.checksum !== input.operation.checksum)
        throw new CommercialRepositoryError(
          409,
          'collaboration_idempotency_conflict',
          'Identifiant d’opération réutilisé avec un autre contenu.',
        );
      return {
        status: 'replayed' as const,
        operation: structuredClone(previous),
        nextCursor: channel.cursor,
      };
    }
    const { checksum: _checksum, ...unsigned } = input.operation;
    const expected = await collaborativeOperationChecksum(unsigned);
    if (expected !== input.operation.checksum)
      throw new CommercialRepositoryError(
        400,
        'collaboration_checksum_invalid',
        'Checksum collaboratif invalide.',
      );
    const record: CollaborativeOperationRecord = {
      ...structuredClone(input.operation),
      actorId: input.context.profileId,
      request_id: input.requestId,
      cursor: ++channel.cursor,
      receivedAt: new Date(this.now()).toISOString(),
    };
    channel.operations.set(record.operationId, record);
    const current = channel.blocks.get(record.mutation.blockId);
    const concurrent =
      current &&
      current.operation.actorId !== record.actorId &&
      current.operation.baseVersionId === record.baseVersionId;
    const wins = !current || tuple(record) > tuple(current.operation);
    if (wins)
      channel.blocks.set(record.mutation.blockId, {
        operation: record,
        tombstone: record.mutation.type === 'block.delete',
      });
    let conflict: CollaborationConflict | undefined;
    if (concurrent || (current?.tombstone && !wins)) {
      conflict = {
        id: crypto.randomUUID(),
        operationId: record.operationId,
        reason:
          current?.tombstone && !wins
            ? 'stale_tombstone'
            : 'concurrent_same_block',
        winningOperationId: wins
          ? record.operationId
          : (current?.operation.operationId ?? null),
        recovery: ['keep_local', 'accept_remote', 'create_copy'],
        createdAt: new Date(this.now()).toISOString(),
      };
      channel.conflicts.push(conflict);
    }
    this.append(
      input.studioId,
      { cursor: record.cursor, type: 'operation.applied', operation: record },
      false,
    );
    if (conflict)
      this.append(input.studioId, {
        cursor: 0,
        type: 'operation.conflict',
        conflict,
      });
    this.audit.push({
      action: conflict ? 'operation.conflict' : 'operation.applied',
      studioId: input.studioId,
      requestId: input.requestId,
      cursor: record.cursor,
    });
    return {
      status: conflict ? ('conflict' as const) : ('applied' as const),
      operation: structuredClone(record),
      ...(conflict ? { conflict: structuredClone(conflict) } : {}),
      nextCursor: channel.cursor,
    };
  }

  async compact(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      parentVersionId: string;
      idempotencyHash: string;
      requestId: string;
    },
  ) {
    this.sweep();
    await this.requireConnection(input, true);
    const channel = this.channel(input.studioId);
    const replay = channel.compactions.get(input.idempotencyHash);
    if (replay) return { ...structuredClone(replay), replayed: true };
    const snapshotPayload = [...channel.blocks.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([blockId, value]) => ({
        blockId,
        tombstone: value.tombstone,
        operationId: value.operation.operationId,
        logicalClock: value.operation.logicalClock,
        actorId: value.operation.actorId,
        mutation: value.operation.mutation,
      }));
    const checksum = await sha256(canonical(snapshotPayload));
    const snapshotId = crypto.randomUUID();
    const value = {
      snapshotId,
      versionId: crypto.randomUUID(),
      parentVersionId: input.parentVersionId,
      cursor: channel.cursor,
      checksum,
      replayed: false,
    };
    channel.snapshots.push(structuredClone(value));
    channel.compactions.set(input.idempotencyHash, structuredClone(value));
    this.append(input.studioId, {
      cursor: 0,
      type: 'snapshot.created',
      snapshotId,
      versionId: value.versionId,
    });
    const minimumAck = Math.min(
      ...[...this.connections.values()]
        .filter((item) => item.studioId === input.studioId)
        .map((item) => item.ackCursor),
      channel.cursor,
    );
    channel.minimumCursor = Math.max(
      channel.minimumCursor,
      Math.max(0, minimumAck - this.policy.tombstoneRetentionOperations),
    );
    this.audit.push({
      action: 'compaction.succeeded',
      studioId: input.studioId,
      requestId: input.requestId,
      cursor: channel.cursor,
    });
    return value;
  }

  async disconnect(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      requestId: string;
    },
  ) {
    const connection = this.connections.get(input.connectionId);
    if (
      connection &&
      connection.profileId === input.context.profileId &&
      connection.studioId === input.studioId
    )
      this.close(connection, 'client', input.requestId);
  }
  async revokeProfile(
    profileId: string,
    reason: ConnectionCloseReason = 'revoked',
  ) {
    for (const ticket of this.tickets.values())
      if (ticket.profileId === profileId) ticket.used = true;
    for (const connection of this.connections.values())
      if (connection.profileId === profileId)
        this.close(connection, reason, crypto.randomUUID());
  }
  async revokeStudioMember(
    studioId: string,
    profileId: string,
    reason: ConnectionCloseReason = 'revoked',
  ) {
    for (const ticket of this.tickets.values())
      if (ticket.studioId === studioId && ticket.profileId === profileId)
        ticket.used = true;
    for (const connection of this.connections.values())
      if (
        connection.studioId === studioId &&
        connection.profileId === profileId
      )
        this.close(connection, reason, crypto.randomUUID());
  }

  private async requireConnection(
    input: CollaborationConnectionContext & {
      studioId: string;
      connectionId: string;
      requestId: string;
    },
    write: boolean,
  ) {
    const connection = this.connections.get(input.connectionId);
    if (
      !connection ||
      connection.studioId !== input.studioId ||
      connection.profileId !== input.context.profileId ||
      connection.fingerprintHash !== input.context.fingerprintHash ||
      connection.origin !== input.origin
    )
      throw new CommercialRepositoryError(
        401,
        'collaboration_connection_closed',
        'Connexion collaborative fermée.',
      );
    try {
      const access = await this.studios.authorizeRealtime(
        input.context,
        input.studioId,
        write,
      );
      connection.role = access.role;
      return connection;
    } catch (error) {
      this.close(connection, 'revoked', input.requestId);
      throw error;
    }
  }
  private channel(studioId: string): Channel {
    let channel = this.channels.get(studioId);
    if (!channel) {
      channel = {
        cursor: 0,
        minimumCursor: 0,
        events: [],
        operations: new Map(),
        blocks: new Map(),
        conflicts: [],
        snapshots: [],
        compactions: new Map(),
      };
      this.channels.set(studioId, channel);
    }
    return channel;
  }
  private append(
    studioId: string,
    event: CollaborationEvent,
    increment = true,
  ) {
    const channel = this.channel(studioId);
    const cursor = increment ? ++channel.cursor : event.cursor;
    channel.events.push(
      structuredClone({ ...event, cursor } as CollaborationEvent),
    );
  }
  private presence(studioId: string): CollaborationPresence[] {
    const grouped = new Map<string, CollaborationPresence>();
    for (const item of this.connections.values())
      if (item.studioId === studioId) {
        const current = grouped.get(item.profileId);
        grouped.set(item.profileId, {
          profileId: item.profileId,
          displayName: item.displayName,
          role: item.role,
          connectionCount: (current?.connectionCount ?? 0) + 1,
          lastHeartbeatAt: new Date(
            Math.max(
              item.heartbeatAt,
              current ? Date.parse(current.lastHeartbeatAt) : 0,
            ),
          ).toISOString(),
        });
      }
    return [...grouped.values()].sort((a, b) =>
      a.profileId.localeCompare(b.profileId),
    );
  }
  private presenceEvent(studioId: string) {
    const channel = this.channel(studioId);
    this.append(
      studioId,
      {
        cursor: channel.cursor,
        type: 'presence.changed',
        presence: this.presence(studioId),
      },
      false,
    );
  }
  private close(
    connection: Connection,
    reason: ConnectionCloseReason,
    requestId: string,
  ) {
    if (!this.connections.delete(connection.id)) return;
    this.append(connection.studioId, {
      cursor: 0,
      type: 'connection.closed',
      profileId: connection.profileId,
      reason,
    });
    this.presenceEvent(connection.studioId);
    this.audit.push({
      action: `connection.${reason}`,
      studioId: connection.studioId,
      requestId,
    });
  }
  private sweep() {
    const now = this.now();
    for (const connection of this.connections.values()) {
      if (
        now - connection.connectedAt >=
        this.policy.maximumConnectionSeconds * 1_000
      )
        this.close(connection, 'expired', crypto.randomUUID());
      else if (
        now - connection.heartbeatAt >=
        this.policy.idleTimeoutSeconds * 1_000
      )
        this.close(connection, 'idle', crypto.randomUUID());
    }
    for (const [hash, ticket] of this.tickets)
      if (ticket.used || ticket.expiresAt <= now) this.tickets.delete(hash);
  }
  private publicLimits(): CollaborationLimits {
    const {
      heartbeatIntervalSeconds,
      idleTimeoutSeconds,
      maximumConnectionSeconds,
      maximumOperationBytes,
      maximumPendingEvents,
      reconnectBackoffMaximumSeconds,
    } = this.policy;
    return {
      heartbeatIntervalSeconds,
      idleTimeoutSeconds,
      maximumConnectionSeconds,
      maximumOperationBytes,
      maximumPendingEvents,
      reconnectBackoffMaximumSeconds,
    };
  }
}
