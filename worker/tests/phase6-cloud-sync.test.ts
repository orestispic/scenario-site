/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLocalRuntime } from '../src/localRuntime.ts';

const DEVICE = 'phase6-studio-device-fingerprint-000001';
const SCENARIO = '60000000-0000-4000-8000-000000000001';
const STUDIO_ID = '10000000-0000-4000-8000-000000000003';
const AUTHOR_ID = '10000000-0000-4000-8000-000000000002';

async function checksum(content: string) {
  const data = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function fixture() {
  const runtime = await createLocalRuntime();
  const call = (
    path: string,
    profile: 'discovery' | 'author' | 'studio',
    body?: unknown,
    options: { key?: string; device?: string; version?: string } = {},
  ) =>
    runtime.worker.fetch(
      new Request(`http://localhost${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer local-test:${profile}`,
          Origin: 'http://localhost:3000',
          'X-Scenario-Client-Version': options.version ?? '0.1.7',
          'X-Scenario-Device-Fingerprint': options.device ?? DEVICE,
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
  await call('/v1/devices/activate', 'studio', {
    fingerprint: DEVICE,
    label: 'Studio',
    platform: 'windows',
  });
  const content = JSON.stringify({
    formatVersion: 1,
    title: 'Privé',
    content: { type: 'doc' },
  });
  const make = async (
    parentVersionId: string | null,
    suffix: string,
    scenarioId = SCENARIO,
  ) => ({
    scenarioId,
    title: `Titre ${suffix}`,
    parentVersionId,
    checksum: await checksum(content + suffix),
    sizeBytes: new TextEncoder().encode(content + suffix).byteLength,
    contentType: 'application/vnd.scenario+json',
    format: 'scenario-v1',
    origin: 'save',
    content: content + suffix,
  });
  // JSON must remain valid while each content/checksum is unique.
  const request = async (
    parentVersionId: string | null,
    suffix: string,
    scenarioId = SCENARIO,
  ) => {
    const document = JSON.stringify({
      formatVersion: 1,
      title: 'Privé',
      content: { type: 'doc' },
      revision: suffix,
    });
    return {
      scenarioId,
      title: `Titre ${suffix}`,
      parentVersionId,
      checksum: await checksum(document),
      sizeBytes: new TextEncoder().encode(document).byteLength,
      contentType: 'application/vnd.scenario+json',
      format: 'scenario-v1',
      origin: 'save',
      content: document,
    };
  };
  return { runtime, call, request, make };
}

describe('synchronisation cloud v6', () => {
  it('crée des versions append-only, rejoue sans doublon et restaure par nouvelle version', async () => {
    const { runtime, call, request } = await fixture();
    const firstBody = await request(null, 'one');
    const first = await call('/v5/scenarios/sync', 'studio', firstBody, {
      key: 'cloud-idempotency-create-0001',
    });
    assert.equal(first.status, 201);
    const created = (await first.json()) as {
      version: { id: string; versionNumber: number };
      download: { url: string };
    };
    const replay = await call('/v5/scenarios/sync', 'studio', firstBody, {
      key: 'cloud-idempotency-create-0001',
    });
    assert.equal(replay.status, 200);
    assert.equal(
      ((await replay.json()) as { replayed: boolean }).replayed,
      true,
    );
    assert.equal(
      (
        await runtime.cloudRepository.versions(
          {
            profileId: STUDIO_ID,
            fingerprintHash: await localHash(DEVICE),
            platform: 'windows',
            clientVersion: '0.1.7',
          },
          SCENARIO,
        )
      ).length,
      1,
    );

    const second = await call(
      '/v5/scenarios/sync',
      'studio',
      await request(created.version.id, 'two'),
      { key: 'cloud-idempotency-create-0002' },
    );
    const secondVersion = ((await second.json()) as { version: { id: string } })
      .version.id;
    const restored = await call(
      `/v5/scenarios/${SCENARIO}/restore`,
      'studio',
      { versionId: created.version.id },
      { key: 'cloud-idempotency-restore-01' },
    );
    assert.equal(restored.status, 201);
    const history = await call(`/v5/scenarios/${SCENARIO}/versions`, 'studio');
    const versions = (
      (await history.json()) as {
        versions: Array<{ origin: string; parentVersionId: string }>;
      }
    ).versions;
    assert.equal(versions.length, 3);
    assert.equal(versions.at(-1)?.origin, 'restore');
    assert.equal(versions.at(-1)?.parentVersionId, secondVersion);
    assert.deepEqual(
      await runtime.scenarioStorage.resolveTemporaryDownload(
        created.download.url,
        STUDIO_ID,
        SCENARIO,
      ),
      new TextEncoder().encode(firstBody.content),
    );
  });

  it('arbitre la concurrence par parent/ETag et renvoie trois options minimales', async () => {
    const { call, request } = await fixture();
    const initial = await call(
      '/v5/scenarios/sync',
      'studio',
      await request(null, 'root'),
      { key: 'cloud-concurrency-root-0001' },
    );
    const parent = ((await initial.json()) as { version: { id: string } })
      .version.id;
    const results = await Promise.all([
      call('/v5/scenarios/sync', 'studio', await request(parent, 'left'), {
        key: 'cloud-concurrency-left-0001',
      }),
      call('/v5/scenarios/sync', 'studio', await request(parent, 'right'), {
        key: 'cloud-concurrency-right-001',
      }),
    ]);
    assert.deepEqual(
      results.map((value) => value.status).sort((left, right) => left - right),
      [201, 409],
    );
    const conflict = (await results
      .find((value) => value.status === 409)!
      .json()) as { conflict: { options: string[] } };
    assert.deepEqual(conflict.conflict.options, [
      'keep_local',
      'download_remote',
      'create_copy',
    ]);
  });

  it('applique droits, appareil, version minimale, viewer/editor et cloisonnement inter-compte', async () => {
    const { runtime, call, request } = await fixture();
    assert.equal((await call('/v5/scenarios', 'discovery')).status, 403);
    assert.equal(
      (await call('/v5/scenarios', 'studio', undefined, { version: '0.0.9' }))
        .status,
      426,
    );
    assert.equal(
      (
        await call('/v5/scenarios', 'studio', undefined, {
          device: 'other-device-fingerprint-000001',
        })
      ).status,
      403,
    );
    const root = await call(
      '/v5/scenarios/sync',
      'studio',
      await request(null, 'root'),
      { key: 'cloud-acl-root-0000000001' },
    );
    const parent = ((await root.json()) as { version: { id: string } }).version
      .id;

    runtime.repository.grantEntitlements(AUTHOR_ID, {
      configurationVersion: 'phase6-test',
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      offlineValidUntil: new Date(Date.now() + 86_400_000).toISOString(),
      deviceLimit: 2,
      entitlements: [
        { code: 'cloud_sync', enabled: true, value: null },
        { code: 'scenario_versions', enabled: true, value: null },
      ],
    });
    const authorDevice = `${DEVICE}-author`;
    await call('/v1/devices/activate', 'author', {
      fingerprint: authorDevice,
      label: 'Auteur',
      platform: 'windows',
    });
    runtime.cloudRepository.addMembership(SCENARIO, AUTHOR_ID, 'viewer');
    assert.equal(
      (
        await call(`/v5/scenarios/${SCENARIO}/versions`, 'author', undefined, {
          device: authorDevice,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          '/v5/scenarios/sync',
          'author',
          await request(parent, 'viewer'),
          { key: 'cloud-viewer-write-00001', device: authorDevice },
        )
      ).status,
      403,
    );
    runtime.cloudRepository.addMembership(SCENARIO, AUTHOR_ID, 'editor');
    assert.equal(
      (
        await call(
          '/v5/scenarios/sync',
          'author',
          await request(parent, 'editor'),
          { key: 'cloud-editor-write-00001', device: authorDevice },
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await call(
          `/v5/scenarios/${SCENARIO}/delete`,
          'author',
          {},
          { key: 'cloud-editor-delete-0001', device: authorDevice },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          `/v5/scenarios/${SCENARIO}/delete`,
          'studio',
          {},
          { key: 'cloud-owner-delete-00001' },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          `/v5/scenarios/${SCENARIO}/restore`,
          'studio',
          { versionId: parent },
          { key: 'cloud-owner-restore-deleted-01' },
        )
      ).status,
      201,
    );
    const devices = (await (await call('/v1/devices', 'studio')).json()) as {
      devices: Array<{ id: string }>;
    };
    await call('/v1/devices/deactivate', 'studio', {
      deviceId: devices.devices[0].id,
    });
    assert.equal((await call('/v5/scenarios', 'studio')).status, 403);
  });

  it('refuse taille, MIME, checksum, traversée et URL temporaire expirée sans exposer le contenu', async () => {
    const { call, request } = await fixture();
    const invalid = await request(null, 'invalid');
    assert.equal(
      (
        await call(
          '/v5/scenarios/sync',
          'studio',
          { ...invalid, checksum: '0'.repeat(64) },
          { key: 'cloud-invalid-checksum-001' },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          '/v5/scenarios/sync',
          'studio',
          { ...invalid, contentType: 'text/plain' },
          { key: 'cloud-invalid-mimetype-001' },
        )
      ).status,
      415,
    );
    assert.equal(
      (
        await call(
          '/v5/scenarios/sync',
          'studio',
          { ...invalid, role: 'owner' },
          { key: 'cloud-privilege-elevation-01' },
        )
      ).status,
      400,
    );
    let now = Date.now();
    const runtime = await createLocalRuntime({}, () => now);
    const stored = runtime.scenarioStorage;
    await assert.rejects(
      () =>
        stored.put({
          key: '../escape',
          bytes: new Uint8Array([1]),
          contentType: 'x',
          checksum: 'a',
        }),
      /Chemin/,
    );
    await stored.put({
      key: 'safe/object',
      bytes: new Uint8Array([1, 2]),
      contentType: 'x',
      checksum: 'ab',
    });
    const grant = await stored.temporaryDownload({
      key: 'safe/object',
      profileId: STUDIO_ID,
      scenarioId: SCENARIO,
      expiresInSeconds: 30,
    });
    await assert.rejects(
      () => stored.resolveTemporaryDownload(grant.url, AUTHOR_ID, SCENARIO),
      /expirée/,
    );
    now += 31_000;
    await assert.rejects(
      () => stored.resolveTemporaryDownload(grant.url, STUDIO_ID, SCENARIO),
      /expirée/,
    );
  });

  it('refuse une session expirée avant toute autorisation cloud', async () => {
    let now = Date.now();
    const runtime = await createLocalRuntime({}, () => now);
    const authCall = (path: string, body: unknown) =>
      runtime.auth.fetch(
        new Request(`http://localhost/_local/auth/v1${path}`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
    await authCall('/signup', {
      email: 'expired-cloud@example.invalid',
      password: 'password-fixture',
    });
    const signed = (await (
      await authCall('/token?grant_type=password', {
        email: 'expired-cloud@example.invalid',
        password: 'password-fixture',
      })
    ).json()) as { access_token: string };
    now += 61_000;
    const result = await runtime.worker.fetch(
      new Request('http://localhost/v5/scenarios', {
        headers: {
          Authorization: `Bearer ${signed.access_token}`,
          'X-Scenario-Client-Version': '0.1.7',
          'X-Scenario-Device-Fingerprint': DEVICE,
          'X-Scenario-Platform': 'windows',
        },
      }),
    );
    assert.equal(result.status, 401);
  });
});

async function localHash(fingerprint: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('ephemeral-local-test-pepper'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(fingerprint),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
