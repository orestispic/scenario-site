/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CollaborativeOperationRequest } from '../../lib/commercial/contracts-v8.ts';
import { CommercialRepositoryError } from '../src/types.ts';
import {
  CloudflareRealtimeTransport,
  collaborativeOperationChecksum,
  type CollaborationChannelNamespace,
} from '../src/realtimeCollaboration.ts';
import { StudioRealtimeChannel } from '../src/studioRealtimeChannel.ts';
import type { WorkerEnvironment } from '../src/types.ts';

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

const STUDIO = '70000000-0000-4000-8000-000000000001';
const SCENARIO = '80000000-0000-4000-8000-000000000001';
const VERSION = '90000000-0000-4000-8000-000000000001';
const PROFILE = '10000000-0000-4000-8000-000000000003';
const environment = {
  STUDIO_TICKET_PEPPER: 'synthetic-durable-channel-ticket-pepper',
  STUDIO_TICKET_TTL_SECONDS: '30',
  STUDIO_HEARTBEAT_SECONDS: '10',
  STUDIO_IDLE_TIMEOUT_SECONDS: '30',
  STUDIO_MAX_CONNECTION_SECONDS: '3600',
  STUDIO_MAX_CONNECTIONS: '32',
  STUDIO_MAX_PROFILE_CONNECTIONS: '3',
  STUDIO_MAX_OPERATION_BYTES: '65536',
  STUDIO_MAX_PENDING_EVENTS: '500',
  STUDIO_EVENT_PAGE_SIZE: '100',
} as WorkerEnvironment;

function state(storage: MemoryStorage) {
  return {
    storage,
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
  };
}

function common() {
  return {
    context: {
      profileId: PROFILE,
      emailHash: 'synthetic-email-hash',
      displayName: 'Owner Person',
      fingerprintHash: 'synthetic-fingerprint-hash',
      platform: 'windows' as const,
      clientVersion: '0.1.7',
    },
    origin: 'https://preproduction.scenario.test',
    studioId: STUDIO,
    requestId: crypto.randomUUID(),
    authorization: { scenarioId: SCENARIO, role: 'owner' as const },
  };
}

describe('Studio Durable Object channel', () => {
  it('survives isolate replacement without persisting presence or raw tickets', async () => {
    const storage = new MemoryStorage();
    let channel = new StudioRealtimeChannel(state(storage), environment);
    const namespace: CollaborationChannelNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: (request) => channel.fetch(request) }),
    };
    const transport = new CloudflareRealtimeTransport(namespace);
    const first = common();
    const issued = await transport.issueTicket(first);

    channel = new StudioRealtimeChannel(state(storage), environment);
    const connected = await transport.connect({
      ...first,
      requestId: crypto.randomUUID(),
      ticket: issued.ticket,
      afterCursor: 0,
    });
    const unsigned = {
      studioId: STUDIO,
      scenarioId: SCENARIO,
      baseVersionId: VERSION,
      operationId: crypto.randomUUID(),
      clientSequence: 1,
      logicalClock: 1,
      mutation: {
        type: 'block.upsert' as const,
        blockId: 'block-1',
        afterBlockId: null,
        block: {
          type: 'paragraph',
          attrs: { blockId: 'block-1' },
          content: [{ type: 'text', text: 'synthetic content' }],
        },
      },
    };
    const operation: CollaborativeOperationRequest = {
      ...unsigned,
      checksum: await collaborativeOperationChecksum(unsigned),
    };
    const applied = await transport.submit({
      ...first,
      requestId: crypto.randomUUID(),
      connectionId: connected.connectionId,
      operation,
    });
    assert.equal(applied.status, 'applied');

    const persisted = JSON.stringify(storage.values.get('channel-state-v1'));
    assert.equal(persisted.includes(issued.ticket), false);
    assert.equal(persisted.includes('Owner Person'), false);
    assert.equal(persisted.includes('presence.changed'), false);

    channel = new StudioRealtimeChannel(state(storage), environment);
    const next = common();
    const nextTicket = await transport.issueTicket(next);
    const resumed = await transport.connect({
      ...next,
      requestId: crypto.randomUUID(),
      ticket: nextTicket.ticket,
      afterCursor: 0,
    });
    const caughtUp = await transport.poll({
      ...next,
      requestId: crypto.randomUUID(),
      connectionId: resumed.connectionId,
      afterCursor: 0,
    });
    assert.equal(caughtUp.events.length, 1);
    assert.equal(caughtUp.events[0]?.type, 'operation.applied');

    const snapshot = await transport.compact({
      ...next,
      requestId: crypto.randomUUID(),
      connectionId: resumed.connectionId,
      parentVersionId: VERSION,
      idempotencyHash: 'durable-snapshot-test',
    });
    const firstArtifact = await transport.snapshotArtifact({
      ...next,
      requestId: crypto.randomUUID(),
      connectionId: resumed.connectionId,
      snapshotId: snapshot.snapshotId,
    });
    assert.deepEqual(firstArtifact.operationIds, [operation.operationId]);
    assert.equal(firstArtifact.entries[0]?.blockId, 'block-1');

    channel = new StudioRealtimeChannel(state(storage), environment);
    const restored = common();
    const restoredTicket = await transport.issueTicket(restored);
    const restoredConnection = await transport.connect({
      ...restored,
      requestId: crypto.randomUUID(),
      ticket: restoredTicket.ticket,
      afterCursor: snapshot.cursor,
    });
    const restoredArtifact = await transport.snapshotArtifact({
      ...restored,
      requestId: crypto.randomUUID(),
      connectionId: restoredConnection.connectionId,
      snapshotId: snapshot.snapshotId,
    });
    assert.deepEqual(restoredArtifact, firstArtifact);
  });

  it('fails closed when the parent Worker omits authorization', async () => {
    const channel = new StudioRealtimeChannel(
      state(new MemoryStorage()),
      environment,
    );
    const { authorization: _authorization, ...input } = common();
    const response = await channel.fetch(
      new Request('https://channel.invalid/internal', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-command': 'ticket' },
        body: JSON.stringify(input),
      }),
    );
    assert.equal(response.status, 403);
  });

  it('preserves a bounded channel rejection code through the Cloudflare bridge', async () => {
    const channel = new StudioRealtimeChannel(
      state(new MemoryStorage()),
      environment,
    );
    const namespace: CollaborationChannelNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: (request) => channel.fetch(request) }),
    };
    const transport = new CloudflareRealtimeTransport(namespace);
    const input = common();
    const issued = await transport.issueTicket(input);
    const connection = {
      ...input,
      requestId: crypto.randomUUID(),
      ticket: issued.ticket,
      afterCursor: 0,
    };
    await transport.connect(connection);
    await assert.rejects(
      () => transport.connect(connection),
      (error: unknown) => {
        assert.ok(error instanceof CommercialRepositoryError);
        assert.equal(error.status, 401);
        assert.equal(error.code, 'collaboration_ticket_invalid');
        return true;
      },
    );
  });
});
