import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/localRuntime.ts';
const profiles = ['studio', 'author', 'discovery'] as const;
type Profile = (typeof profiles)[number];
export const ids = {
  studio: '10000000-0000-4000-8000-000000000003',
  author: '10000000-0000-4000-8000-000000000002',
  discovery: '10000000-0000-4000-8000-000000000001',
};
export async function metadataFixture() {
  const metrics: unknown[] = [];
  const runtime = await createLocalRuntime({
    telemetry: { record: (m) => metrics.push(m) },
  });
  for (const p of profiles)
    runtime.repository.grantEntitlements(ids[p], {
      configurationVersion: 'phase10-synthetic',
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      offlineValidUntil: new Date(Date.now() + 86400000).toISOString(),
      deviceLimit: 3,
      entitlements: [
        'cloud_sync',
        'scenario_versions',
        'studio_collaboration',
      ].map((code) => ({ code, enabled: true, value: null })),
    });
  async function call(
    path: string,
    p: Profile = 'studio',
    body?: unknown,
    key = crypto.randomUUID(),
    extra = {},
  ) {
    return runtime.worker.fetch(
      new Request(`http://localhost${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer local-test:${p}`,
          Origin: 'http://localhost:3000',
          'X-Scenario-Client-Version': '0.1.7',
          'X-Scenario-Device-Fingerprint': `phase10-device-fingerprint-${p}`,
          'X-Scenario-Platform': 'windows',
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Idempotency-Key': key }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  for (const p of profiles)
    assert.equal(
      (
        await call('/v1/devices/activate', p, {
          fingerprint: `phase10-device-fingerprint-${p}`,
          platform: 'windows',
          label: p,
        })
      ).status,
      201,
    );
  async function create(title: string, metadata: Record<string, unknown> = {}) {
    const content = JSON.stringify({
      formatVersion: 1,
      title,
      content: { type: 'doc', content: [] },
      ...metadata,
    });
    const bytes = new TextEncoder().encode(content);
    const checksum = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const id = crypto.randomUUID();
    assert.equal(
      (
        await call('/v5/scenarios/sync', 'studio', {
          scenarioId: id,
          title,
          parentVersionId: null,
          content,
          checksum,
          sizeBytes: bytes.length,
          contentType: 'application/vnd.scenario+json',
          format: 'scenario-v1',
          origin: 'save',
        })
      ).status,
      201,
    );
    return id;
  }
  async function share(id: string) {
    const response = await call(`/v9/projects/${id}/sharing`, 'studio', {});
    assert.equal(response.status, 200);
    return ((await response.json()) as { studio: { id: string } }).studio.id;
  }
  async function invite(studioId: string, p: Profile, role = 'editor') {
    const response = await call(
      `/v6/studios/${studioId}/invitations`,
      'studio',
      { email: `${p}@example.invalid`, role },
    );
    assert.equal(response.status, 201);
    return ((await response.json()) as { invitation: { id: string } })
      .invitation.id;
  }
  return { runtime, call, create, share, invite, metrics };
}
