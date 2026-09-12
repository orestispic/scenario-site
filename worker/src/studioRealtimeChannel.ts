import type { CollaborationRole } from '../../lib/commercial/contracts-v8.ts';
import {
  DeterministicLocalRealtimeTransport,
  type CollaborationConnectionContext,
  type DurableRealtimeState,
  type RealtimePolicy,
} from './realtimeCollaboration.ts';
import type { StudioContext, StudioRepository } from './studio.ts';
import { CommercialRepositoryError, type WorkerEnvironment } from './types.ts';
import { SupabaseCollaborationLedger, type CollaborationLedger } from './collaborationLedger.ts';

type OutboxEntry = Parameters<CollaborationLedger['appendOperation']>[0] & { attempts: number; blocked: boolean };
type DurableChannelState = DurableRealtimeState & { outboxVersion?: 1; outbox?: OutboxEntry[] };

interface ChannelStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm?(time: number): Promise<void>;
}

interface ChannelState {
  storage: ChannelStorage;
  blockConcurrencyWhile?<T>(callback: () => Promise<T>): Promise<T>;
}

type AuthorizedInput = CollaborationConnectionContext & {
  studioId: string;
  requestId: string;
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error('Invalid Studio channel configuration.');
  return parsed;
}

function internalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function policy(environment: WorkerEnvironment): RealtimePolicy {
  return {
    ticketTtlSeconds: boundedInteger(
      environment.STUDIO_TICKET_TTL_SECONDS,
      30,
      5,
      120,
    ),
    heartbeatIntervalSeconds: boundedInteger(
      environment.STUDIO_HEARTBEAT_SECONDS,
      10,
      2,
      60,
    ),
    idleTimeoutSeconds: boundedInteger(
      environment.STUDIO_IDLE_TIMEOUT_SECONDS,
      30,
      5,
      300,
    ),
    maximumConnectionSeconds: boundedInteger(
      environment.STUDIO_MAX_CONNECTION_SECONDS,
      3_600,
      60,
      86_400,
    ),
    maximumConnectionsPerStudio: boundedInteger(
      environment.STUDIO_MAX_CONNECTIONS,
      32,
      1,
      1_000,
    ),
    maximumConnectionsPerProfile: boundedInteger(
      environment.STUDIO_MAX_PROFILE_CONNECTIONS,
      3,
      1,
      20,
    ),
    maximumOperationBytes: boundedInteger(
      environment.STUDIO_MAX_OPERATION_BYTES,
      65_536,
      1_024,
      262_144,
    ),
    maximumPendingEvents: boundedInteger(
      environment.STUDIO_MAX_PENDING_EVENTS,
      500,
      10,
      10_000,
    ),
    maximumEventsPerPoll: boundedInteger(
      environment.STUDIO_EVENT_PAGE_SIZE,
      100,
      1,
      500,
    ),
    reconnectBackoffMaximumSeconds: 30,
    tombstoneRetentionOperations: 100,
  };
}

class RequestAuthorization {
  private current:
    | {
        profileId: string;
        studioId: string;
        scenarioId: string;
        role: CollaborationRole;
      }
    | undefined;

  set(input: AuthorizedInput): void {
    const authorization = input.authorization;
    if (
      !authorization ||
      typeof authorization.scenarioId !== 'string' ||
      !['owner', 'editor', 'viewer'].includes(authorization.role)
    )
      throw new CommercialRepositoryError(
        403,
        'channel_authorization_missing',
        'Autorisation du canal manquante.',
      );
    this.current = {
      profileId: input.context.profileId,
      studioId: input.studioId,
      scenarioId: authorization.scenarioId,
      role: authorization.role,
    };
  }

  async authorizeRealtime(
    context: StudioContext,
    studioId: string,
    write: boolean,
  ) {
    const current = this.current;
    if (
      !current ||
      current.profileId !== context.profileId ||
      current.studioId !== studioId
    )
      throw new CommercialRepositoryError(
        403,
        'channel_authorization_invalid',
        'Autorisation du canal invalide.',
      );
    if (write && current.role === 'viewer')
      throw new CommercialRepositoryError(
        403,
        'studio_write_forbidden',
        'Écriture Studio refusée.',
      );
    return {
      studioId,
      scenarioId: current.scenarioId,
      role: current.role,
    };
  }
}

/**
 * Private Durable Object channel. The public Worker authenticates and
 * authorizes every command before forwarding it through the binding.
 * Presence and live connections remain memory-only; hashed tickets and the
 * bounded operation/snapshot channel survive isolate eviction.
 */
export class StudioRealtimeChannel {
  private readonly authorization = new RequestAuthorization();
  private readonly transport: DeterministicLocalRealtimeTransport;
  private readonly ready: Promise<void>;
  private commands: Promise<unknown> = Promise.resolve();
  private queuedCommands = 0;
  private outbox: OutboxEntry[] = [];
  private readonly ledger?: CollaborationLedger;

  constructor(
    private readonly state: ChannelState,
    environment: WorkerEnvironment,
    ledger?: CollaborationLedger,
  ) {
    this.ledger = ledger ?? (environment.SUPABASE_URL && (environment.SUPABASE_SECRET_KEY || environment.SUPABASE_SERVICE_ROLE_KEY) ? new SupabaseCollaborationLedger(environment) : undefined);
    if (this.ledger && !state.storage.setAlarm) throw new Error('Durable outbox alarm storage required.');
    const ticketPepper = environment.STUDIO_TICKET_PEPPER?.trim();
    if (!ticketPepper) throw new Error('Studio ticket pepper is required.');
    this.transport = new DeterministicLocalRealtimeTransport(
      this.authorization as unknown as StudioRepository,
      ticketPepper,
      policy(environment),
    );
    const restore = async () => {
      const saved = await state.storage.get<DurableChannelState>('channel-state-v1');
      this.transport.restoreDurableState(saved);
      this.outbox = saved?.outbox ?? [];
      if (this.outbox.some((entry) => !entry.blocked)) await state.storage.setAlarm?.(Date.now() + 1000);
    };
    this.ready = state.blockConcurrencyWhile
      ? state.blockConcurrencyWhile(restore)
      : restore();
  }

  async fetch(request: Request): Promise<Response> {
    // Await points allow multiple fetch handlers to interleave in a Durable
    // Object. Serialize authorization + mutation + persistence as one command.
    // Otherwise RequestAuthorization.current can belong to another profile.
    if (this.queuedCommands >= 64)
      return Response.json({ code: 'channel_unavailable' }, { status: 503 });
    this.queuedCommands += 1;
    const result = this.commands.then(() => this.execute(request));
    this.commands = result.catch(() => undefined);
    try {
      return await result;
    } finally {
      this.queuedCommands -= 1;
    }
  }

  private async execute(request: Request): Promise<Response> {
    await this.ready;
    if (request.method !== 'POST')
      return Response.json({ code: 'method_not_allowed' }, { status: 405 });
    const command = request.headers.get('x-command') ?? '';
    const source = await request.text();
    if (new TextEncoder().encode(source).byteLength > 131_072)
      return Response.json(
        { code: 'channel_payload_too_large' },
        { status: 413 },
      );
    const previous = this.transport.durableState();
    const previousOutbox = structuredClone(this.outbox);
    let committed = false;
    try {
      const body = JSON.parse(source) as AuthorizedInput &
        Record<string, unknown>;
      if (!['revoke-profile', 'revoke-member'].includes(command))
        this.authorization.set(body);

      let result: unknown;
      let persist = false;
      switch (command) {
        case 'ticket':
          result = await this.transport.issueTicket(
            body as Parameters<
              DeterministicLocalRealtimeTransport['issueTicket']
            >[0],
          );
          persist = true;
          break;
        case 'connect':
          result = await this.transport.connect(
            body as unknown as Parameters<
              DeterministicLocalRealtimeTransport['connect']
            >[0],
          );
          persist = true;
          break;
        case 'heartbeat':
          result = await this.transport.heartbeat(
            body as unknown as Parameters<
              DeterministicLocalRealtimeTransport['heartbeat']
            >[0],
          );
          break;
        case 'poll':
          result = await this.transport.poll(
            body as unknown as Parameters<
              DeterministicLocalRealtimeTransport['poll']
            >[0],
          );
          break;
        case 'submit':
          if (this.ledger && this.outbox.length >= 32)
            throw new CommercialRepositoryError(503, 'collaboration_ledger_incomplete', 'Écritures en attente de réconciliation.');
          result = await this.transport.submit(
            body as unknown as Parameters<
              DeterministicLocalRealtimeTransport['submit']
            >[0],
          );
          if (this.ledger) {
            const record = (result as Awaited<ReturnType<DeterministicLocalRealtimeTransport['submit']>>).operation;
            if (record.actorId !== body.context.profileId) throw new CommercialRepositoryError(409, 'collaboration_idempotency_conflict', 'Opération liée à un autre auteur.');
            if (!this.outbox.some((entry) => entry.operation.operationId === record.operationId)) {
              const { actorId, request_id, cursor: _cursor, receivedAt: _received, ...operation } = record;
              this.outbox.push({
                context: { profileId: actorId, fingerprintHash: body.context.fingerprintHash, platform: body.context.platform, clientVersion: body.context.clientVersion, emailHash: '', displayName: '' },
                origin: '', studioId: body.studioId, requestId: request_id, operation, attempts: 0, blocked: false,
              });
            }
          }
          persist = true;
          break;
        case 'compact':
          if (this.outbox.length) throw new CommercialRepositoryError(503, 'collaboration_ledger_incomplete', 'Réconciliation requise avant compaction.');
          result = await this.transport.compact(
            body as unknown as Parameters<
              DeterministicLocalRealtimeTransport['compact']
            >[0],
          );
          persist = true;
          break;
        case 'snapshot-artifact':
          result = await this.transport.snapshotArtifact(
            body as unknown as Parameters<
              DeterministicLocalRealtimeTransport['snapshotArtifact']
            >[0],
          );
          break;
        case 'disconnect':
          await this.transport.disconnect(
            body as unknown as Parameters<
              DeterministicLocalRealtimeTransport['disconnect']
            >[0],
          );
          result = { closed: true };
          break;
        case 'revoke-profile':
          await this.transport.revokeProfile(
            internalString(body.profileId),
            body.reason as Parameters<
              DeterministicLocalRealtimeTransport['revokeProfile']
            >[1],
          );
          result = { closed: true };
          persist = true;
          break;
        case 'revoke-member':
          await this.transport.revokeStudioMember(
            internalString(body.studioId),
            internalString(body.profileId),
            body.reason as Parameters<
              DeterministicLocalRealtimeTransport['revokeStudioMember']
            >[2],
          );
          result = { closed: true };
          persist = true;
          break;
        default:
          return Response.json(
            { code: 'channel_command_invalid' },
            { status: 400 },
          );
      }
      if (persist) {
        // Arm BEFORE committing: a crash between the put and scheduling an alarm
        // must not strand accepted operations. One put atomically stores both.
        if (this.outbox.length) await this.state.storage.setAlarm?.(Date.now() + 1000);
        await this.persist();
        committed = true;
      }
      if (command === 'submit' && this.ledger) {
        await this.drain();
        if (this.outbox.some((entry) => entry.operation.operationId === (body.operation as { operationId: string }).operationId))
          throw new CommercialRepositoryError(503, 'collaboration_ledger_incomplete', 'Écriture conservée, confirmation en attente.');
      }
      return Response.json(result);
    } catch (error) {
      if (!committed) { this.transport.restoreDurableState(previous); this.outbox = previousOutbox; }
      if (error instanceof CommercialRepositoryError)
        return Response.json({ code: error.code }, { status: error.status });
      return Response.json({ code: 'channel_unavailable' }, { status: 503 });
    }
  }

  private async persist(): Promise<void> {
    const saved: DurableChannelState = { ...this.transport.durableState(), outboxVersion: 1, outbox: this.outbox };
    // SQLite-backed Cloudflare values are bounded (2 MB). Keep headroom for
    // structured serialization. Refuse the new operation before confirming
    // it rather than allowing the in-memory channel to diverge from storage.
    if (new TextEncoder().encode(JSON.stringify(saved)).byteLength > 1024 * 1024)
      throw new CommercialRepositoryError(503, 'channel_backpressure', 'Capacité du canal atteinte : conservez une copie et contactez le support.');
    await this.state.storage.put('channel-state-v1', saved);
  }

  async alarm(): Promise<void> {
    const result = this.commands.then(async () => { await this.ready; await this.drain(); });
    this.commands = result.catch(() => undefined);
    await result;
  }

  private async drain(): Promise<void> {
    if (!this.ledger || !this.outbox.length) return;
    // Preserve causal order. A rejected earlier operation blocks later entries.
    for (const entry of this.outbox.slice(0, 8)) {
      if (entry.blocked) break;
      try {
        await this.ledger.appendOperation(entry);
        const saved = this.outbox;
        this.outbox = this.outbox.filter((item) => item !== entry);
        try { await this.persist(); } catch (error) { this.outbox = saved; throw error; }
      } catch (error) {
        entry.attempts = Math.min(entry.attempts + 1, 30);
        entry.blocked = error instanceof CommercialRepositoryError && [400, 403, 404, 409, 426].includes(error.status);
        await this.persist();
        console.warn(JSON.stringify({ event: entry.blocked ? 'studio.outbox_blocked' : 'studio.outbox_retry', request_id: entry.requestId, backlog_depth: this.outbox.length, attempts: entry.attempts }));
        break;
      }
    }
    const first = this.outbox[0];
    if (first && !first.blocked) await this.state.storage.setAlarm?.(Date.now() + Math.min(300000, 1000 * 2 ** Math.min(first.attempts, 8)));
  }
}
