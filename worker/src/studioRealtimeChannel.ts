import type { CollaborationRole } from '../../lib/commercial/contracts-v8.ts';
import {
  DeterministicLocalRealtimeTransport,
  type CollaborationConnectionContext,
  type DurableRealtimeState,
  type RealtimePolicy,
} from './realtimeCollaboration.ts';
import type { StudioContext, StudioRepository } from './studio.ts';
import { CommercialRepositoryError, type WorkerEnvironment } from './types.ts';

interface ChannelStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
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

  constructor(
    private readonly state: ChannelState,
    environment: WorkerEnvironment,
  ) {
    const ticketPepper = environment.STUDIO_TICKET_PEPPER?.trim();
    if (!ticketPepper) throw new Error('Studio ticket pepper is required.');
    this.transport = new DeterministicLocalRealtimeTransport(
      this.authorization as unknown as StudioRepository,
      ticketPepper,
      policy(environment),
    );
    const restore = async () => {
      this.transport.restoreDurableState(
        await state.storage.get<DurableRealtimeState>('channel-state-v1'),
      );
    };
    this.ready = state.blockConcurrencyWhile
      ? state.blockConcurrencyWhile(restore)
      : restore();
  }

  async fetch(request: Request): Promise<Response> {
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
          result = await this.transport.submit(
            body as unknown as Parameters<
              DeterministicLocalRealtimeTransport['submit']
            >[0],
          );
          persist = true;
          break;
        case 'compact':
          result = await this.transport.compact(
            body as unknown as Parameters<
              DeterministicLocalRealtimeTransport['compact']
            >[0],
          );
          persist = true;
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
      if (persist)
        await this.state.storage.put(
          'channel-state-v1',
          this.transport.durableState(),
        );
      return Response.json(result);
    } catch (error) {
      if (error instanceof CommercialRepositoryError)
        return Response.json({ code: error.code }, { status: error.status });
      return Response.json({ code: 'channel_unavailable' }, { status: 503 });
    }
  }
}
