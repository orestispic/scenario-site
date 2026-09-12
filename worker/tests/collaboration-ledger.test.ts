/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CollaborativeOperationRequest } from '../../lib/commercial/contracts-v8.ts';
import {
  mergeCollaborationSnapshot,
  ReconciledRealtimeTransport,
  SupabaseCollaborationLedger,
  SupabaseCollaborationSnapshotPersistence,
  type CollaborationLedger,
} from '../src/collaborationLedger.ts';
import type {
  CloudScenarioRepository,
  ScenarioObjectStorage,
} from '../src/cloudSync.ts';
import type { RealtimeCollaborationTransport } from '../src/realtimeCollaboration.ts';
import type { WorkerEnvironment } from '../src/types.ts';

const context = {
  profileId: '10000000-0000-4000-8000-000000000001',
  emailHash: 'email-hash',
  displayName: 'Synthetic Owner',
  fingerprintHash: 'a'.repeat(64),
  platform: 'windows' as const,
  clientVersion: '0.1.7',
};
const common = {
  context,
  origin: 'http://127.0.0.1:1420',
  authorization: {
    scenarioId: '30000000-0000-4000-8000-000000000001',
    role: 'owner' as const,
  },
  studioId: '20000000-0000-4000-8000-000000000001',
  requestId: '40000000-0000-4000-8000-000000000001',
};
const operation: CollaborativeOperationRequest = {
  studioId: common.studioId,
  scenarioId: common.authorization.scenarioId,
  baseVersionId: '50000000-0000-4000-8000-000000000001',
  operationId: '60000000-0000-4000-8000-000000000001',
  clientSequence: 1,
  logicalClock: 1,
  mutation: {
    type: 'block.delete',
    blockId: 'synthetic-block',
  },
  checksum: 'b'.repeat(64),
};

function channel(overrides: Partial<RealtimeCollaborationTransport> = {}) {
  return {
    issueTicket: async () => ({
      ticket: 'ticket',
      expiresAt: new Date().toISOString(),
      maximumUses: 1 as const,
    }),
    connect: async () => {
      throw new Error('not used');
    },
    heartbeat: async () => {
      throw new Error('not used');
    },
    poll: async () => ({
      events: [],
      nextCursor: 7,
      hasMore: false,
      syncLag: 0,
    }),
    submit: async () => ({ status: 'applied' as const, nextCursor: 7 }),
    compact: async () => {
      throw new Error('not used');
    },
    disconnect: async () => {},
    revokeProfile: async () => {},
    revokeStudioMember: async () => {},
    ...overrides,
  } satisfies RealtimeCollaborationTransport;
}

describe('realtime Supabase reconciliation', () => {
  it('repairs only missing records of the authenticated author, preserving original attribution', async () => {
    const appended: Record<string, unknown>[] = [];
    const ledger = new SupabaseCollaborationLedger(
      {
        SUPABASE_URL: 'https://synthetic.supabase.co',
        SUPABASE_SECRET_KEY: 'synthetic-secret',
      } as WorkerEnvironment,
      async (_url, init) => {
        if (!init?.body) return Response.json([]);
        assert.equal(typeof init.body, 'string');
        appended.push(JSON.parse(init.body as string) as Record<string, unknown>);
        return Response.json({ status: 'applied', cursor: 1 });
      },
    );
    const record = {
      ...operation,
      actorId: context.profileId,
      request_id: common.requestId,
      cursor: 7,
      receivedAt: new Date().toISOString(),
    };
    await ledger.reconcileOwnOperations({
      ...common,
      operations: [
        record,
        {
          ...record,
          actorId: 'another-profile',
          operationId: crypto.randomUUID(),
        },
      ],
    });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].p_profile_id, context.profileId);
    assert.equal(appended[0].p_request_id, common.requestId);
    assert.equal(appended[0].p_operation_id, operation.operationId);
    assert.equal(appended[0].p_checksum, operation.checksum);
  });

  it('repairs the ledger before acknowledging a poll', async () => {
    const order: string[] = [];
    const ledger: CollaborationLedger = {
      appendOperation: async () => ({ status: 'applied', cursor: 1 }),
      reconcileOwnOperations: async () => {
        order.push('repair');
      },
      acknowledgeOperations: async () => {
        order.push('ack');
        return 1;
      },
    };
    const transport = new ReconciledRealtimeTransport(channel(), ledger);
    await transport.poll({
      ...common,
      connectionId: crypto.randomUUID(),
      afterCursor: 0,
    });
    assert.deepEqual(order, ['repair', 'ack']);
  });
  it('persists an operation after the channel and retries without double attribution', async () => {
    const order: string[] = [];
    let channelCalls = 0;
    let ledgerCalls = 0;
    const ledger: CollaborationLedger = {
      appendOperation: async () => {
        order.push('ledger');
        ledgerCalls += 1;
        if (ledgerCalls === 1) throw new Error('synthetic ledger outage');
        return { status: 'applied', cursor: 1 };
      },
      acknowledgeOperations: async () => null,
    };
    const transport = new ReconciledRealtimeTransport(
      channel({
        submit: async () => {
          order.push('channel');
          channelCalls += 1;
          return {
            status: channelCalls === 1 ? 'applied' : 'replayed',
            nextCursor: 7,
          };
        },
      }),
      ledger,
    );
    const input = { ...common, connectionId: crypto.randomUUID(), operation };
    await assert.rejects(
      () => transport.submit(input),
      /synthetic ledger outage/,
    );
    const replay = await transport.submit(input);
    assert.equal(replay.status, 'replayed');
    assert.deepEqual(order, ['channel', 'ledger', 'channel', 'ledger']);
  });

  it('acknowledges only operation ids actually returned by the channel', async () => {
    const acknowledgements: string[][] = [];
    const ledger: CollaborationLedger = {
      appendOperation: async () => ({ status: 'applied', cursor: 1 }),
      acknowledgeOperations: async ({ operationIds }) => {
        acknowledgements.push(operationIds);
        return 41;
      },
    };
    const transport = new ReconciledRealtimeTransport(
      channel({
        poll: async () => ({
          events: [
            {
              cursor: 6,
              type: 'operation.applied',
              operation: {
                ...operation,
                actorId: context.profileId,
                request_id: common.requestId,
                cursor: 6,
                receivedAt: new Date().toISOString(),
              },
            },
            {
              cursor: 7,
              type: 'connection.closed',
              profileId: context.profileId,
              reason: 'client',
            },
          ],
          nextCursor: 7,
          hasMore: false,
          syncLag: 0,
        }),
      }),
      ledger,
    );
    const result = await transport.poll({
      ...common,
      connectionId: crypto.randomUUID(),
      afterCursor: 3,
    });
    assert.equal(result.nextCursor, 7);
    assert.deepEqual(acknowledgements, [[operation.operationId]]);
  });

  it('maps an operation to the existing append-only RPC without tickets or content logs', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const environment = {
      SUPABASE_URL: 'https://synthetic.supabase.co',
      SUPABASE_SECRET_KEY: 'synthetic-secret',
    } as WorkerEnvironment;
    const ledger = new SupabaseCollaborationLedger(
      environment,
      async (_input, init) => {
        const body = init?.body;
        assert.equal(typeof body, 'string');
        requestBody = JSON.parse(body as string);
        return Response.json({ status: 'applied', cursor: 1 });
      },
    );
    await ledger.appendOperation({ ...common, operation });
    assert.equal(requestBody?.p_operation_id, operation.operationId);
    assert.equal(requestBody?.p_operation_type, 'block.delete');
    assert.equal(requestBody?.p_block_id, 'synthetic-block');
    assert.equal('ticket' in (requestBody ?? {}), false);
    assert.equal('connection_id' in (requestBody ?? {}), false);
  });

  it('maps channel operation ids to PostgreSQL cursors before acknowledging', async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const environment = {
      SUPABASE_URL: 'https://synthetic.supabase.co',
      SUPABASE_SECRET_KEY: 'synthetic-secret',
    } as WorkerEnvironment;
    const ledger = new SupabaseCollaborationLedger(
      environment,
      async (input, init) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        const body = init?.body;
        requests.push({
          url,
          ...(typeof body === 'string' ? { body: JSON.parse(body) } : {}),
        });
        return url.includes('studio_collaboration_operations?')
          ? Response.json([{ operation_id: operation.operationId, cursor: 41 }])
          : Response.json(41);
      },
    );
    const cursor = await ledger.acknowledgeOperations({
      ...common,
      operationIds: [operation.operationId, operation.operationId],
    });
    assert.equal(cursor, 41);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /operation_id=in\.%28/);
    assert.equal(requests[1].body?.p_cursor, 41);
  });

  it('merges winning mutations into a complete scenario without dropping metadata', () => {
    const parent = new TextEncoder().encode(
      JSON.stringify({
        formatVersion: 1,
        title: 'Synthetic scenario',
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', attrs: { blockId: 'keep' } },
            { type: 'paragraph', attrs: { blockId: 'remove' } },
          ],
        },
        characters: ['A'],
        comments: [{ id: 'preserved' }],
      }),
    );
    const merged = mergeCollaborationSnapshot(parent, {
      snapshotId: crypto.randomUUID(),
      versionId: crypto.randomUUID(),
      parentVersionId: operation.baseVersionId,
      channelCursor: 3,
      operationIds: [operation.operationId],
      entries: [
        {
          blockId: 'remove',
          tombstone: true,
          operationId: crypto.randomUUID(),
          logicalClock: 1,
          actorId: context.profileId,
          mutation: { type: 'block.delete', blockId: 'remove' },
        },
        {
          blockId: 'added',
          tombstone: false,
          operationId: crypto.randomUUID(),
          logicalClock: 2,
          actorId: context.profileId,
          mutation: {
            type: 'block.upsert',
            blockId: 'added',
            afterBlockId: 'keep',
            block: { type: 'paragraph', attrs: { blockId: 'added' } },
          },
        },
      ],
    });
    const document = JSON.parse(new TextDecoder().decode(merged));
    assert.deepEqual(document.characters, ['A']);
    assert.deepEqual(document.comments, [{ id: 'preserved' }]);
    assert.deepEqual(
      document.content.content.map((block: Record<string, unknown>) =>
        blockIdForTest(block),
      ),
      ['keep', 'added'],
    );
  });

  it('uploads bytes before atomically committing matching snapshot and version ids', async () => {
    const snapshotId = '70000000-0000-4000-8000-000000000001';
    const versionId = '80000000-0000-4000-8000-000000000001';
    const order: string[] = [];
    let stored: Uint8Array | undefined;
    let rpcBody: Record<string, unknown> | undefined;
    const cloud = {
      list: async () => [
        {
          id: operation.scenarioId,
          title: 'Synthetic scenario',
          role: 'owner' as const,
          currentVersionId: operation.baseVersionId,
          deletedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      storageKey: async () => 'parent.scenario',
    } as unknown as CloudScenarioRepository;
    const storage: ScenarioObjectStorage = {
      get: async () =>
        new TextEncoder().encode(
          JSON.stringify({
            formatVersion: 1,
            title: 'Synthetic scenario',
            content: { type: 'doc', content: [] },
          }),
        ),
      put: async ({ bytes }) => {
        order.push('object');
        stored = bytes;
      },
      temporaryDownload: async () => {
        throw new Error('not used');
      },
    };
    const persistence = new SupabaseCollaborationSnapshotPersistence(
      {
        SUPABASE_URL: 'https://synthetic.supabase.co',
        SUPABASE_SECRET_KEY: 'synthetic-secret',
      } as WorkerEnvironment,
      cloud,
      storage,
      'synthetic-storage-key-pepper',
      async (input, init) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        if (url.includes('studio_collaboration_operations?'))
          return Response.json([
            { operation_id: operation.operationId, cursor: 41 },
          ]);
        order.push('sql');
        assert.equal(typeof init?.body, 'string');
        rpcBody = JSON.parse(init?.body as string);
        return Response.json({ replayed: false });
      },
    );
    const result = await persistence.persist({
      ...common,
      connectionId: crypto.randomUUID(),
      idempotencyHash: 'c'.repeat(64),
      parentVersionId: operation.baseVersionId,
      channel: {
        snapshotId,
        versionId,
        parentVersionId: operation.baseVersionId,
        cursor: 3,
        checksum: 'd'.repeat(64),
        replayed: false,
      },
      artifact: {
        snapshotId,
        versionId,
        parentVersionId: operation.baseVersionId,
        channelCursor: 3,
        operationIds: [operation.operationId],
        entries: [],
      },
    });
    assert.deepEqual(order, ['object', 'sql']);
    assert.ok(stored && stored.byteLength > 2);
    assert.equal(rpcBody?.p_snapshot_id, snapshotId);
    assert.equal(rpcBody?.p_version_id, versionId);
    assert.equal(rpcBody?.p_through_cursor, 41);
    assert.equal(result.snapshotId, snapshotId);
    assert.equal(result.versionId, versionId);
  });
});

function blockIdForTest(block: Record<string, unknown>) {
  return (block.attrs as { blockId?: string } | undefined)?.blockId;
}
