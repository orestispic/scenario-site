/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLocalRuntime } from '../src/localRuntime.ts';
import { collaborativeOperationChecksum } from '../src/realtimeCollaboration.ts';
import type { CollaborativeOperationRequest } from '../../lib/commercial/contracts-v8.ts';

type Profile = 'discovery' | 'author' | 'studio';
const IDS: Record<Profile, string> = {
  discovery: '10000000-0000-4000-8000-000000000001',
  author: '10000000-0000-4000-8000-000000000002',
  studio: '10000000-0000-4000-8000-000000000003',
};
const SCENARIO = '80000000-0000-4000-8000-000000000001';
const DEVICES: Record<Profile, string> = {
  discovery: 'phase8-discovery-device-00000001',
  author: 'phase8-author-device-0000000001',
  studio: 'phase8-studio-device-0000000001',
};
async function sha(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
async function fixture() {
  const clock = { value: Date.now() };
  const metrics: unknown[] = [];
  const runtime = await createLocalRuntime(
    { telemetry: { record: (metric) => metrics.push(metric) } },
    () => clock.value,
  );
  const call = (
    path: string,
    profile: Profile,
    body?: unknown,
    options: {
      key?: string;
      version?: string;
      device?: string;
      origin?: string;
    } = {},
  ) =>
    runtime.worker.fetch(
      new Request(`http://localhost${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer local-test:${profile}`,
          Origin: options.origin ?? 'http://localhost:3000',
          'X-Scenario-Client-Version': options.version ?? '0.1.7',
          'X-Scenario-Device-Fingerprint': options.device ?? DEVICES[profile],
          'X-Scenario-Platform': 'windows',
          ...(body === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Idempotency-Key': options.key ?? crypto.randomUUID(),
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  for (const profile of Object.keys(DEVICES) as Profile[]) {
    if (profile !== 'studio')
      runtime.repository.grantEntitlements(IDS[profile], {
        configurationVersion: 'phase8-test',
        issuedAt: new Date(clock.value).toISOString(),
        expiresAt: null,
        offlineValidUntil: new Date(clock.value + 86_400_000).toISOString(),
        deviceLimit: 2,
        entitlements: [
          { code: 'cloud_sync', enabled: true, value: null },
          { code: 'scenario_versions', enabled: true, value: null },
          { code: 'studio_collaboration', enabled: true, value: null },
        ],
      });
    assert.equal(
      (
        await call('/v1/devices/activate', profile, {
          fingerprint: DEVICES[profile],
          label: profile,
          platform: 'windows',
        })
      ).status,
      201,
    );
  }
  for (const profile of ['author', 'discovery'] as const) {
    assert.equal((await call('/v15/contact-requests', 'studio', { email: `${profile}@example.invalid` })).status, 201);
    const received = await (await call('/v15/contacts', profile)).json() as { receivedRequests: Array<{ id: string }> };
    assert.equal((await call(`/v15/contact-requests/${received.receivedRequests[0].id}/respond`, profile, { decision: 'accept' })).status, 200);
  }
  const content = JSON.stringify({
    formatVersion: 1,
    title: 'Fixture',
    content: { type: 'doc', content: [] },
  });
  const synced = await call(
    '/v5/scenarios/sync',
    'studio',
    {
      scenarioId: SCENARIO,
      title: 'Fixture',
      parentVersionId: null,
      checksum: await sha(content),
      sizeBytes: new TextEncoder().encode(content).byteLength,
      contentType: 'application/vnd.scenario+json',
      format: 'scenario-v1',
      origin: 'save',
      content,
    },
    { key: 'phase8-cloud-root-000000000001' },
  );
  const baseVersionId = ((await synced.json()) as { version: { id: string } })
    .version.id;
  const created = await call(
    '/v6/studios',
    'studio',
    { scenarioId: SCENARIO, name: 'Studio temps réel' },
    { key: 'phase8-studio-create-000000001' },
  );
  const studioId = ((await created.json()) as { studio: { id: string } }).studio
    .id;
  async function invite(
    profile: Exclude<Profile, 'studio'>,
    role: 'editor' | 'viewer',
  ) {
    await call(
      `/v6/studios/${studioId}/invitations`,
      'studio',
      { email: `${profile}@example.invalid`, role },
      { key: `phase8-invite-${profile}-000000001` },
    );
    const token = (
      (await (await call('/v6/studios', profile)).json()) as {
        receivedInvitations: Array<{ developmentToken: string }>;
      }
    ).receivedInvitations[0].developmentToken;
    await call(
      '/v6/studio-invitations/accept',
      profile,
      { token },
      { key: `phase8-accept-${profile}-000000001` },
    );
  }
  await invite('author', 'editor');
  await invite('discovery', 'viewer');
  async function connect(
    profile: Profile,
    afterCursor = 0,
    options: { version?: string; device?: string; origin?: string } = {},
  ) {
    const ticketResponse = await call(
      `/v7/studios/${studioId}/realtime/tickets`,
      profile,
      {},
      options,
    );
    const ticket = ((await ticketResponse.json()) as { ticket: string }).ticket;
    const response = await call(
      `/v7/studios/${studioId}/realtime/connect`,
      profile,
      { ticket, afterCursor },
      options,
    );
    return {
      ticket,
      response,
      value: (await response.clone().json()) as {
        connectionId: string;
        cursor: number;
      },
    };
  }
  async function operation(
    profile: Profile,
    connectionId: string,
    blockId: string,
    text: string,
    logicalClock = 1,
    operationId = crypto.randomUUID(),
  ) {
    const unsigned = {
      studioId,
      scenarioId: SCENARIO,
      baseVersionId,
      operationId,
      clientSequence: logicalClock,
      logicalClock,
      mutation: {
        type: 'block.upsert' as const,
        blockId,
        afterBlockId: null,
        block: {
          type: 'paragraph',
          attrs: { blockId },
          content: [{ type: 'text', text }],
        },
      },
    };
    const body: CollaborativeOperationRequest = {
      ...unsigned,
      checksum: await collaborativeOperationChecksum(unsigned),
    };
    return call(
      `/v7/studios/${studioId}/realtime/operations`,
      profile,
      { connectionId, operation: body },
      { key: operationId },
    );
  }
  return {
    runtime,
    call,
    connect,
    operation,
    studioId,
    baseVersionId,
    metrics,
    clock,
  };
}

describe('collaboration temps réel v8', () => {
  it('connecte trois comptes, garde la présence éphémère et borne un ticket à un usage/origine/appareil', async () => {
    const { connect, call, studioId } = await fixture();
    const first = await connect('studio');
    assert.equal(first.response.status, 201);
    assert.equal(
      (
        await call(`/v7/studios/${studioId}/realtime/connect`, 'studio', {
          ticket: first.ticket,
          afterCursor: 0,
        })
      ).status,
      401,
    );
    const author = await connect('author');
    const viewer = await connect('discovery');
    const heartbeat = await call(
      `/v7/studios/${studioId}/realtime/heartbeat`,
      'studio',
      { connectionId: first.value.connectionId },
    );
    assert.equal(heartbeat.status, 200);
    assert.equal(
      ((await heartbeat.json()) as { presence: unknown[] }).presence.length,
      3,
    );
    const ticket = await call(
      `/v7/studios/${studioId}/realtime/tickets`,
      'studio',
      {},
    );
    const raw = ((await ticket.json()) as { ticket: string }).ticket;
    assert.equal(
      (
        await call(
          `/v7/studios/${studioId}/realtime/connect`,
          'studio',
          { ticket: raw, afterCursor: 0 },
          { origin: 'http://127.0.0.1:3000' },
        )
      ).status,
      401,
    );
    assert.ok(author.value.connectionId && viewer.value.connectionId);
  });

  it('fusionne des blocs distincts, déduplique les retries et expose le conflit concurrent sans perte silencieuse', async () => {
    const { connect, operation, call, studioId } = await fixture();
    const owner = await connect('studio');
    const author = await connect('author');
    const firstId = '81000000-0000-4000-8000-000000000001';
    const first = await operation(
      'studio',
      owner.value.connectionId,
      'block-a',
      'contenu-secret-A',
      1,
      firstId,
    );
    assert.equal(first.status, 200);
    assert.equal(
      ((await first.json()) as { status: string }).status,
      'applied',
    );
    const retry = await operation(
      'studio',
      owner.value.connectionId,
      'block-a',
      'contenu-secret-A',
      1,
      firstId,
    );
    assert.equal(
      ((await retry.json()) as { status: string }).status,
      'replayed',
    );
    const conflict = await operation(
      'author',
      author.value.connectionId,
      'block-a',
      'contenu-secret-B',
      1,
    );
    const conflictBody = (await conflict.json()) as {
      status: string;
      conflict: { recovery: string[] };
    };
    assert.equal(conflictBody.status, 'conflict');
    assert.deepEqual(conflictBody.conflict.recovery, [
      'keep_local',
      'accept_remote',
      'create_copy',
    ]);
    assert.equal(
      (
        await operation(
          'author',
          author.value.connectionId,
          'block-b',
          'indépendant',
          2,
        )
      ).status,
      200,
    );
    const poll = await call(`/v7/studios/${studioId}/realtime/poll`, 'studio', {
      connectionId: owner.value.connectionId,
      afterCursor: owner.value.cursor,
    });
    const events = (
      (await poll.json()) as { events: Array<{ cursor: number }> }
    ).events;
    assert.ok(
      events.every(
        (event, index) =>
          index === 0 || event.cursor > events[index - 1].cursor,
      ),
    );
  });

  it('refuse viewer, portée tierce, ancienne version et ferme le membre révoqué', async () => {
    const { connect, operation, call, studioId, baseVersionId } =
      await fixture();
    const viewer = await connect('discovery');
    assert.equal(
      (
        await operation(
          'discovery',
          viewer.value.connectionId,
          'block-v',
          'refusé',
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          `/v7/studios/${studioId}/realtime/tickets`,
          'studio',
          {},
          { version: '0.0.1' },
        )
      ).status,
      426,
    );
    const owner = await connect('studio');
    assert.equal(
      (
        await call(`/v7/studios/${studioId}/realtime/operations`, 'studio', {
          connectionId: owner.value.connectionId,
          operation: {
            studioId,
            scenarioId: SCENARIO,
            baseVersionId,
            operationId: crypto.randomUUID(),
            clientSequence: 1,
            logicalClock: 1,
            mutation: { type: 'block.delete', blockId: 'forbidden' },
            checksum: '0'.repeat(64),
            actorId: IDS.studio,
          },
        })
      ).status,
      400,
    );
    const author = await connect('author');
    await call(
      `/v6/studios/${studioId}/members/${IDS.author}/remove`,
      'studio',
      {},
      { key: 'phase8-remove-author-0000000001' },
    );
    assert.equal(
      (
        await call(`/v7/studios/${studioId}/realtime/heartbeat`, 'author', {
          connectionId: author.value.connectionId,
        })
      ).status,
      404,
    );
    const invalid = await operation(
      'studio',
      owner.value.connectionId,
      'block-scope',
      'x',
    );
    assert.equal(invalid.status, 200);
    assert.equal(
      (
        await call(`/v7/studios/${studioId}/realtime/operations`, 'studio', {
          connectionId: owner.value.connectionId,
          operation: { oversized: 'x'.repeat(70_000) },
        })
      ).status,
      413,
    );
    await call(
      `/v5/scenarios/${SCENARIO}/delete`,
      'studio',
      {},
      { key: 'phase8-delete-private-scenario-001' },
    );
    assert.equal(
      (await call(`/v7/studios/${studioId}/realtime/tickets`, 'studio', {}))
        .status,
      404,
    );
  });

  it('ferme sur révocation appareil, expiration heartbeat et backpressure', async () => {
    const { runtime, connect, call, studioId, clock } = await fixture();
    const owner = await connect('studio');
    const devices = (await (await call('/v1/devices', 'studio')).json()) as {
      devices: Array<{ id: string }>;
    };
    await call('/v1/devices/deactivate', 'studio', {
      deviceId: devices.devices[0].id,
    });
    assert.equal(
      (
        await call(`/v7/studios/${studioId}/realtime/heartbeat`, 'studio', {
          connectionId: owner.value.connectionId,
        })
      ).status,
      403,
    );
    await call('/v1/devices/activate', 'studio', {
      fingerprint: DEVICES.studio,
      label: 'studio',
      platform: 'windows',
    });
    const idle = await connect('studio');
    clock.value += 31_000;
    assert.equal(
      (
        await call(`/v7/studios/${studioId}/realtime/heartbeat`, 'studio', {
          connectionId: idle.value.connectionId,
        })
      ).status,
      401,
    );
    const session = await connect('studio');
    await call('/v1/auth/logout', 'studio', {});
    assert.equal(
      (
        await call(`/v7/studios/${studioId}/realtime/heartbeat`, 'studio', {
          connectionId: session.value.connectionId,
        })
      ).status,
      401,
    );
    runtime.realtimeTransport.policy.maximumPendingEvents = 1;
    const fresh = await connect('studio');
    await connect('author');
    await connect('discovery');
    assert.equal(
      (
        await call(`/v7/studios/${studioId}/realtime/poll`, 'studio', {
          connectionId: fresh.value.connectionId,
          afterCursor: fresh.value.cursor,
        })
      ).status,
      429,
    );
  });

  it('compacte de façon idempotente, rend le curseur ancien explicite et ne journalise aucun contenu/ticket', async () => {
    const {
      runtime,
      connect,
      operation,
      call,
      studioId,
      baseVersionId,
      metrics,
    } = await fixture();
    runtime.realtimeTransport.policy.tombstoneRetentionOperations = 0;
    const owner = await connect('studio');
    await operation(
      'studio',
      owner.value.connectionId,
      'block-compact',
      'contenu-ultra-secret',
    );
    const polled = await call(
      `/v7/studios/${studioId}/realtime/poll`,
      'studio',
      {
        connectionId: owner.value.connectionId,
        afterCursor: owner.value.cursor,
      },
    );
    const cursor = ((await polled.json()) as { nextCursor: number }).nextCursor;
    await call(`/v7/studios/${studioId}/realtime/poll`, 'studio', {
      connectionId: owner.value.connectionId,
      afterCursor: cursor,
    });
    const key = 'phase8-compaction-idempotent-0001';
    const first = await call(
      `/v7/studios/${studioId}/realtime/compact`,
      'studio',
      {
        connectionId: owner.value.connectionId,
        parentVersionId: baseVersionId,
      },
      { key },
    );
    const second = await call(
      `/v7/studios/${studioId}/realtime/compact`,
      'studio',
      {
        connectionId: owner.value.connectionId,
        parentVersionId: baseVersionId,
      },
      { key },
    );
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(
      ((await second.json()) as { replayed: boolean }).replayed,
      true,
    );
    await call(`/v7/studios/${studioId}/realtime/disconnect`, 'studio', {
      connectionId: owner.value.connectionId,
    });
    assert.equal((await connect('studio', 0)).response.status, 409);
    const serialized =
      JSON.stringify(metrics) + JSON.stringify(runtime.realtimeTransport.audit);
    assert.equal(serialized.includes('contenu-ultra-secret'), false);
    assert.equal(serialized.includes('phase8-compaction-idempotent'), false);
  });

  it('échoue sûrement quand le canal distribué n’est pas configuré et refuse une session absente', async () => {
    const { runtime, studioId } = await fixture();
    const unconfigured = await createLocalRuntime({
      realtimeTransport: undefined,
    });
    const headers = {
      Authorization: 'Bearer local-test:studio',
      Origin: 'http://localhost:3000',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'phase8-unconfigured-00000001',
      'X-Scenario-Client-Version': '0.1.7',
      'X-Scenario-Device-Fingerprint': DEVICES.studio,
      'X-Scenario-Platform': 'windows',
    };
    assert.equal(
      (
        await unconfigured.worker.fetch(
          new Request(
            `http://localhost/v7/studios/${studioId}/realtime/tickets`,
            { method: 'POST', headers, body: '{}' },
          ),
        )
      ).status,
      503,
    );
    assert.equal(
      (
        await runtime.worker.fetch(
          new Request(
            `http://localhost/v7/studios/${studioId}/realtime/tickets`,
            {
              method: 'POST',
              headers: {
                Origin: 'http://localhost:3000',
                'Content-Type': 'application/json',
                'Idempotency-Key': 'phase8-no-session-0000000001',
                'X-Scenario-Client-Version': '0.1.7',
                'X-Scenario-Device-Fingerprint': DEVICES.studio,
                'X-Scenario-Platform': 'windows',
              },
              body: '{}',
            },
          ),
        )
      ).status,
      401,
    );
  });
});
