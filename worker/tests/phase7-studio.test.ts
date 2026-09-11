/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLocalRuntime } from '../src/localRuntime.ts';
import type { WorkerDependencies } from '../src/types.ts';
import { DeterministicLocalStudioNotifier } from '../src/studio.ts';

type Profile = 'discovery' | 'author' | 'studio';
const IDS = {
  discovery: '10000000-0000-4000-8000-000000000001',
  author: '10000000-0000-4000-8000-000000000002',
  studio: '10000000-0000-4000-8000-000000000003',
};
const SCENARIO = '70000000-0000-4000-8000-000000000001';
const DEVICES: Record<Profile, string> = {
  discovery: 'phase7-discovery-device-000000001',
  author: 'phase7-author-device-00000000001',
  studio: 'phase7-studio-device-000000000001',
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
async function fixture(
  now = { value: Date.now() },
  overrides: Partial<WorkerDependencies> = {},
) {
  const metrics: unknown[] = [];
  const runtime = await createLocalRuntime(
    { telemetry: { record: (metric) => metrics.push(metric) }, ...overrides },
    () => now.value,
  );
  for (const profileId of [IDS.discovery, IDS.author]) {
    runtime.repository.grantEntitlements(profileId, {
      configurationVersion: 'phase7-test',
      issuedAt: new Date(now.value).toISOString(),
      expiresAt: null,
      offlineValidUntil: new Date(now.value + 86_400_000).toISOString(),
      deviceLimit: 2,
      entitlements: [
        { code: 'cloud_sync', enabled: true, value: null },
        { code: 'scenario_versions', enabled: true, value: null },
        { code: 'studio_collaboration', enabled: true, value: null },
      ],
    });
  }
  const call = (
    path: string,
    profile: Profile,
    body?: unknown,
    options: { key?: string; version?: string; device?: string } = {},
  ) =>
    runtime.worker.fetch(
      new Request(`http://localhost${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer local-test:${profile}`,
          Origin: 'http://localhost:3000',
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
  for (const profile of Object.keys(DEVICES) as Profile[])
    await call('/v1/devices/activate', profile, {
      fingerprint: DEVICES[profile],
      label: profile,
      platform: 'windows',
    });
  const content = JSON.stringify({
    formatVersion: 1,
    title: 'Privé',
    content: { type: 'doc' },
  });
  const synced = await call(
    '/v5/scenarios/sync',
    'studio',
    {
      scenarioId: SCENARIO,
      title: 'Privé',
      parentVersionId: null,
      checksum: await sha(content),
      sizeBytes: new TextEncoder().encode(content).byteLength,
      contentType: 'application/vnd.scenario+json',
      format: 'scenario-v1',
      origin: 'save',
      content,
    },
    { key: 'phase7-cloud-create-000000001' },
  );
  assert.equal(synced.status, 201);
  const created = await call(
    '/v6/studios',
    'studio',
    { scenarioId: SCENARIO, name: 'Studio roman' },
    { key: 'phase7-studio-create-00000001' },
  );
  assert.equal(created.status, 201);
  const studioId = ((await created.json()) as { studio: { id: string } }).studio
    .id;
  return { runtime, call, studioId, metrics, now };
}

describe('collaboration Studio v7', () => {
  it('crée, invite et accepte atomiquement une seule fois avec replay idempotent', async () => {
    const { runtime, call, studioId } = await fixture();
    const invited = await call(
      `/v6/studios/${studioId}/invitations`,
      'studio',
      { email: 'author@example.invalid', role: 'viewer' },
      { key: 'phase7-invite-author-000000001' },
    );
    assert.equal(invited.status, 201);
    const invitation = (await invited.json()) as {
      invitation: { id: string; tokenHash?: string };
    };
    assert.equal(invitation.invitation.tokenHash, undefined);
    const received = await call('/v6/studios', 'author');
    const token = (
      (await received.json()) as {
        receivedInvitations: Array<{ developmentToken: string }>;
      }
    ).receivedInvitations[0].developmentToken;
    assert.match(token, /^[0-9a-f-]{36}\.[0-9a-f]{64}$/i);
    const results = await Promise.all([
      call(
        '/v6/studio-invitations/accept',
        'author',
        { token },
        { key: 'phase7-atomic-accept-000000001' },
      ),
      call(
        '/v6/studio-invitations/accept',
        'author',
        { token },
        { key: 'phase7-atomic-accept-000000001' },
      ),
    ]);
    assert.deepEqual(
      results.map((item) => item.status).sort((left, right) => left - right),
      [200, 201],
    );
    assert.equal(
      (
        await call(
          '/v6/studio-invitations/accept',
          'author',
          { token },
          { key: 'phase7-second-consume-00000001' },
        )
      ).status,
      409,
    );
    assert.equal(
      runtime.studioRepository.membershipJournal.filter(
        (item) => item.profileId === IDS.author,
      ).length,
      1,
    );
  });

  it('applique owner/editor/viewer, refuse auto-élévation et protège le dernier owner', async () => {
    const { call, studioId } = await fixture();
    await call(
      `/v6/studios/${studioId}/invitations`,
      'studio',
      { email: 'author@example.invalid', role: 'viewer' },
      { key: 'phase7-role-invite-00000000001' },
    );
    const token = (
      (await (await call('/v6/studios', 'author')).json()) as {
        receivedInvitations: Array<{ developmentToken: string }>;
      }
    ).receivedInvitations[0].developmentToken;
    await call(
      '/v6/studio-invitations/accept',
      'author',
      { token },
      { key: 'phase7-role-accept-00000000001' },
    );
    assert.equal(
      (
        await call(
          `/v6/studios/${studioId}/invitations`,
          'author',
          { email: 'x@example.invalid', role: 'viewer' },
          { key: 'phase7-viewer-invite-000000001' },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          `/v6/studios/${studioId}/members/${IDS.author}/role`,
          'studio',
          { role: 'editor' },
          { key: 'phase7-promote-editor-000000001' },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          `/v6/studios/${studioId}/members/${IDS.author}/role`,
          'author',
          { role: 'owner' },
          { key: 'phase7-self-elevate-00000000001' },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          `/v6/studios/${studioId}/members/${IDS.author}/role`,
          'studio',
          { role: 'owner' },
          { key: 'phase7-promote-owner-0000000001' },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          `/v6/studios/${studioId}/members/${IDS.studio}/remove`,
          'studio',
          {},
          { key: 'phase7-remove-self-owner-000001' },
        )
      ).status,
      200,
    );
    assert.equal((await call(`/v6/studios/${studioId}`, 'studio')).status, 404);
    assert.equal(
      (
        await call(
          `/v6/studios/${studioId}/members/${IDS.author}/remove`,
          'author',
          {},
          { key: 'phase7-remove-last-owner-000001' },
        )
      ).status,
      409,
    );
  });

  it('refuse invitations expirées, révoquées, destinées à un tiers et dissimule les ressources privées', async () => {
    const { call, studioId, now } = await fixture();
    await call(
      `/v6/studios/${studioId}/invitations`,
      'studio',
      { email: 'discovery@example.invalid', role: 'viewer' },
      { key: 'phase7-expire-invite-000000001' },
    );
    let received = (await (await call('/v6/studios', 'discovery')).json()) as {
      receivedInvitations: Array<{ id: string; developmentToken: string }>;
    };
    assert.equal(
      (
        await call(
          '/v6/studio-invitations/accept',
          'author',
          { token: received.receivedInvitations[0].developmentToken },
          { key: 'phase7-third-party-00000000001' },
        )
      ).status,
      404,
    );
    now.value += 86_401_000;
    assert.equal(
      (
        await call(
          '/v6/studio-invitations/accept',
          'discovery',
          { token: received.receivedInvitations[0].developmentToken },
          { key: 'phase7-expired-accept-00000001' },
        )
      ).status,
      410,
    );
    now.value -= 86_401_000;
    const fresh = await call(
      `/v6/studios/${studioId}/invitations`,
      'studio',
      { email: 'discovery@example.invalid', role: 'editor' },
      { key: 'phase7-revoke-invite-000000001' },
    );
    const inviteId = ((await fresh.json()) as { invitation: { id: string } })
      .invitation.id;
    received = (await (
      await call('/v6/studios', 'discovery')
    ).json()) as typeof received;
    const freshToken = received.receivedInvitations.find(
      (item) => item.id === inviteId,
    )!.developmentToken;
    await call(
      `/v6/studios/${studioId}/invitations/${inviteId}/revoke`,
      'studio',
      {},
      { key: 'phase7-revoke-action-000000001' },
    );
    assert.equal(
      (
        await call(
          '/v6/studio-invitations/accept',
          'discovery',
          { token: freshToken },
          { key: 'phase7-revoked-accept-00000001' },
        )
      ).status,
      409,
    );
    const declined = await call(
      `/v6/studios/${studioId}/invitations`,
      'studio',
      { email: 'discovery@example.invalid', role: 'viewer' },
      { key: 'phase7-decline-invite-00000001' },
    );
    const declinedId = (
      (await declined.json()) as { invitation: { id: string } }
    ).invitation.id;
    received = (await (
      await call('/v6/studios', 'discovery')
    ).json()) as typeof received;
    const declinedToken = received.receivedInvitations.find(
      (item) => item.id === declinedId,
    )!.developmentToken;
    assert.equal(
      (
        await call(
          '/v6/studio-invitations/decline',
          'discovery',
          { token: declinedToken },
          { key: 'phase7-decline-action-000000001' },
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await call(
          '/v6/studio-invitations/decline',
          'discovery',
          { token: declinedToken },
          { key: 'phase7-decline-action-000000001' },
        )
      ).status,
      200,
    );
    assert.equal((await call(`/v6/studios/${studioId}`, 'author')).status, 404);
  });

  it('bloque immédiatement appareil/membership révoqué, ancienne version et scénario supprimé', async () => {
    const { call, studioId } = await fixture();
    assert.equal(
      (await call('/v6/studios', 'studio', undefined, { version: '0.0.1' }))
        .status,
      426,
    );
    const devices = (await (await call('/v1/devices', 'studio')).json()) as {
      devices: Array<{ id: string }>;
    };
    await call('/v1/devices/deactivate', 'studio', {
      deviceId: devices.devices[0].id,
    });
    assert.equal((await call('/v6/studios', 'studio')).status, 403);
    await call('/v1/devices/activate', 'studio', {
      fingerprint: DEVICES.studio,
      label: 'studio',
      platform: 'windows',
    });
    await call(
      `/v5/scenarios/${SCENARIO}/delete`,
      'studio',
      {},
      { key: 'phase7-delete-scenario-0000001' },
    );
    assert.equal((await call(`/v6/studios/${studioId}`, 'studio')).status, 404);
  });

  it('conserve un journal append-only et rattrape par curseur sans fuite dans les métriques', async () => {
    const { call, studioId, metrics, runtime } = await fixture();
    const before = await call(
      `/v6/studios/${studioId}/events?after=0&limit=1`,
      'studio',
    );
    const page = (await before.json()) as {
      events: Array<{ cursor: number }>;
      nextCursor: number;
      hasMore: boolean;
    };
    assert.equal(page.events.length, 1);
    await call(
      `/v6/studios/${studioId}/invitations`,
      'studio',
      { email: 'author@example.invalid', role: 'editor' },
      { key: 'phase7-events-invite-000000001' },
    );
    const history = (await (
      await call(`/v5/scenarios/${SCENARIO}/versions`, 'studio')
    ).json()) as { versions: Array<{ id: string }> };
    const content = JSON.stringify({
      formatVersion: 1,
      title: 'Privé',
      content: { type: 'doc' },
      revision: 2,
    });
    await call(
      '/v5/scenarios/sync',
      'studio',
      {
        scenarioId: SCENARIO,
        title: 'Privé 2',
        parentVersionId: history.versions[0].id,
        checksum: await sha(content),
        sizeBytes: new TextEncoder().encode(content).byteLength,
        contentType: 'application/vnd.scenario+json',
        format: 'scenario-v1',
        origin: 'save',
        content,
      },
      { key: 'phase7-version-event-000000001' },
    );
    const after = (await (
      await call(
        `/v6/studios/${studioId}/events?after=${page.nextCursor}`,
        'studio',
      )
    ).json()) as { events: Array<{ cursor: number }> };
    assert.ok(after.events.every((event) => event.cursor > page.nextCursor));
    assert.ok(
      runtime.studioRepository.eventJournal.every(
        (event, index, all) =>
          index === 0 || event.cursor > all[index - 1].cursor,
      ),
    );
    assert.ok(
      runtime.studioRepository.eventJournal.some(
        (event) => event.type === 'scenario.version_created',
      ),
    );
    const serialized = JSON.stringify(metrics);
    assert.equal(serialized.includes('author@example.invalid'), false);
    assert.equal(serialized.includes('phase7-events-invite'), false);
  });

  it('conserve la mutation lors d’une panne de notification et refuse une session absente', async () => {
    const notifier = new DeterministicLocalStudioNotifier();
    let attempts = 0;
    const flaky = {
      developmentToken: notifier.developmentToken.bind(notifier),
      async deliver(input: Parameters<typeof notifier.deliver>[0]) {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        await notifier.deliver(input);
      },
    };
    const { runtime, call, studioId } = await fixture(
      { value: Date.now() },
      { studioNotifier: flaky },
    );
    assert.equal(
      (await runtime.worker.fetch(new Request('http://localhost/v6/studios')))
        .status,
      401,
    );
    const request = { email: 'author@example.invalid', role: 'viewer' };
    const options = { key: 'phase7-notifier-outage-00000001' };
    const first = await call(
      `/v6/studios/${studioId}/invitations`,
      'studio',
      request,
      options,
    );
    assert.equal(first.status, 201);
    assert.equal(
      (
        await call(
          `/v6/studios/${studioId}/invitations`,
          'studio',
          request,
          options,
        )
      ).status,
      200,
    );
    const received = (await (await call('/v6/studios', 'author')).json()) as {
      receivedInvitations: Array<{ developmentToken?: string }>;
    };
    assert.ok(received.receivedInvitations[0].developmentToken);
    assert.equal(attempts, 2);
  });
});
