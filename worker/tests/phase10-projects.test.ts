/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createLocalRuntime } from '../src/localRuntime.ts';
import { InMemoryRateLimiter } from '../src/rateLimit.ts';
import type { CloudProjectListResponse } from '../../lib/commercial/contracts-v9.ts';
import type { CollaborationTicketResponse, CollaborationConnectionResponse } from '../../lib/commercial/contracts-v8.ts';
import type { CloudScenarioListResponse, CloudSyncResponse } from '../../lib/commercial/contracts-v6.ts';

const profiles = ['studio','author','discovery'] as const;
type Profile = typeof profiles[number];
const ids = { studio: '10000000-0000-4000-8000-000000000003', author: '10000000-0000-4000-8000-000000000002', discovery: '10000000-0000-4000-8000-000000000001' };
async function fixture() {
  const metrics: unknown[] = [];
  const runtime = await createLocalRuntime({ telemetry: { record: (m) => metrics.push(m) } });
  for (const p of profiles) runtime.repository.grantEntitlements(ids[p], {
    configurationVersion: 'phase10-synthetic', issuedAt: new Date().toISOString(), expiresAt: null,
    offlineValidUntil: new Date(Date.now()+86400000).toISOString(), deviceLimit: 3,
    entitlements: ['cloud_sync','scenario_versions','studio_collaboration'].map((code) => ({ code, enabled: true, value: null })),
  });
  async function call(path: string, p: Profile = 'studio', body?: unknown, key = crypto.randomUUID(), extra = {}) {
    return runtime.worker.fetch(new Request(`http://localhost${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: {
        Authorization: `Bearer local-test:${p}`, Origin: 'http://localhost:3000',
        'X-Scenario-Client-Version': '0.1.7', 'X-Scenario-Device-Fingerprint': `phase10-device-fingerprint-${p}`, 'X-Scenario-Platform': 'windows',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }), ...extra,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }
  for (const p of profiles) assert.equal((await call('/v1/devices/activate', p, { fingerprint: `phase10-device-fingerprint-${p}`, platform: 'windows', label: p })).status, 201);
  async function create(title: string) {
    const content = JSON.stringify({ formatVersion: 1, title, content: { type: 'doc', content: [] } });
    const bytes = new TextEncoder().encode(content);
    const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2,'0')).join('');
    const id = crypto.randomUUID();
    assert.equal((await call('/v5/scenarios/sync', 'studio', { scenarioId: id, title, parentVersionId: null, content, checksum, sizeBytes: bytes.length, contentType: 'application/vnd.scenario+json', format: 'scenario-v1', origin: 'save' })).status, 201);
    return id;
  }
  async function share(id: string) {
    const response = await call(`/v9/projects/${id}/sharing`, 'studio', {});
    assert.equal(response.status, 200);
    return ((await response.json()) as { studio: { id: string } }).studio.id;
  }
  async function invite(studioId: string, p: Profile, role = 'editor') {
    const response = await call(`/v6/studios/${studioId}/invitations`, 'studio', { email: `${p}@example.invalid`, role });
    assert.equal(response.status, 201);
    return ((await response.json()) as { invitation: { id: string } }).invitation.id;
  }
  return { runtime, call, create, share, invite, metrics };
}

it('private cloud projects need no team; two projects have independent member lists', async () => {
  const { call, create, share, invite, metrics } = await fixture();
  const a = await create('SYNTHETIC_PRIVATE_CONTENT'), b = await create('Second project');
  const list = await (await call('/v9/projects')).json() as CloudProjectListResponse;
  assert.equal(list.contractVersion, '2026-09-v9');
  assert.equal(list.projects.length, 2);
  assert.ok(list.projects.every((p) => p.sharing === 'private' && p.realtimeStudioId === null && p.memberCount === 1));
  const studio = await share(a);
  assert.equal(await share(a), studio, 'repeated ensure is stable');
  const invitation = await invite(studio, 'author');
  assert.equal((await call(`/v9/project-invitations/${invitation}/respond`, 'discovery', { decision: 'accept' })).status, 404);
  const key = crypto.randomUUID();
  const accepted = await Promise.all(Array.from({length: 4}, () => call(`/v9/project-invitations/${invitation}/respond`, 'author', { decision: 'accept' }, key)));
  assert.ok(accepted.every((r) => r.status === 200));
  const authorList = await (await call('/v9/projects', 'author')).json() as CloudProjectListResponse;
  assert.deepEqual(authorList.projects.map((p) => p.id), [a]);
  assert.equal(authorList.projects[0].role, 'editor');
  assert.equal(authorList.projects[0].sharing, 'shared');
  assert.equal((await call(`/v5/scenarios/${b}/versions`, 'author')).status, 404);
  assert.equal((await call(`/v9/projects/${b}/sharing`, 'author', {})).status, 404);
  assert.equal((await call(`/v9/projects/${a}/sharing`, 'author', {})).status, 404);
  assert.doesNotMatch(JSON.stringify(metrics), /SYNTHETIC_PRIVATE_CONTENT|example.invalid|tokenHash|device-fingerprint/);
});

it('viewer cannot elevate; removal revokes access only to that project', async () => {
  const { call, create, share, invite } = await fixture();
  const a = await create('A'), b = await create('B');
  const sa = await share(a), sb = await share(b);
  for (const s of [sa, sb]) {
    const i = await invite(s, 'discovery', 'viewer');
    assert.equal((await call(`/v9/project-invitations/${i}/respond`, 'discovery', {decision: 'accept'})).status, 200);
  }
  assert.equal((await call(`/v6/studios/${sa}/members/${ids.discovery}/role`, 'discovery', {role: 'owner'})).status, 404);
  assert.equal((await call(`/v9/projects/${a}/sharing`, 'discovery', {})).status, 404);
  const ticket = await (await call(`/v7/studios/${sa}/realtime/tickets`, 'discovery', {})).json() as CollaborationTicketResponse;
  const connected = await (await call(`/v7/studios/${sa}/realtime/connect`, 'discovery', {ticket: ticket.ticket, afterCursor: 0})).json() as CollaborationConnectionResponse;
  assert.equal((await call(`/v6/studios/${sa}/members/${ids.discovery}/remove`, 'studio', {})).status, 200);
  assert.equal((await call(`/v7/studios/${sa}/realtime/heartbeat`, 'discovery', {connectionId: connected.connectionId})).status, 404);
  const listed = await (await call('/v9/projects', 'discovery')).json() as CloudProjectListResponse;
  assert.deepEqual(listed.projects.map((p) => p.id), [b]);
});

it('rejects expired session, old client, inactive device, forged fields and deleted project invitations', async () => {
  const { call, create, share, invite } = await fixture();
  assert.equal((await call('/v9/projects', 'studio', undefined, undefined, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await call('/v9/projects', 'studio', undefined, undefined, { 'X-Scenario-Client-Version': '0.0.1' })).status, 426);
  assert.equal((await call('/v9/projects', 'studio', undefined, undefined, { 'X-Scenario-Device-Fingerprint': 'inactive-device-fingerprint' })).status, 403);
  const id = await create('deleted'), studio = await share(id), inviteId = await invite(studio, 'author');
  assert.equal((await call(`/v9/project-invitations/${inviteId}/respond`, 'author', {decision: 'accept', role: 'owner'})).status, 400);
  await call(`/v5/scenarios/${id}/delete`, 'studio', {});
  assert.equal((await call(`/v9/project-invitations/${inviteId}/respond`, 'author', {decision: 'accept'})).status, 404);
});

it('private listing needs cloud rights but not a collaboration entitlement', async () => {
  const { runtime, call } = await fixture();
  runtime.repository.grantEntitlements(ids.author, { configurationVersion: 'cloud-only', issuedAt: new Date().toISOString(), expiresAt: null, offlineValidUntil: new Date(Date.now()+86400000).toISOString(), deviceLimit: 3, entitlements: ['cloud_sync', 'scenario_versions'].map((code) => ({ code, enabled: true, value: null })) });
  const r = await call('/v9/projects', 'author'); assert.equal(r.status, 200);
  assert.deepEqual((await r.json() as CloudProjectListResponse).receivedInvitations, []);
});

it('sharing freezes the last private version and revoked writers cannot replay a historical save', async () => {
  const {call, create, share, invite} = await fixture();
  const id = await create('Private first');
  const list = await (await call('/v5/scenarios')).json() as CloudScenarioListResponse;
  const content = JSON.stringify({formatVersion:1,title:'Private latest',content:{type:'doc',content:[]}});
  const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map((b) => b.toString(16).padStart(2,'0')).join('');
  const body = {scenarioId:id, title:'Private latest', parentVersionId:list.scenarios[0].currentVersionId, content, checksum, sizeBytes:new TextEncoder().encode(content).length, contentType:'application/vnd.scenario+json', format:'scenario-v1', origin:'save'};
  const savedResponse = await call('/v5/scenarios/sync', 'studio', body);
  assert.equal(savedResponse.status,201);
  const saved = await savedResponse.json() as CloudSyncResponse;
  const studio = await share(id);
  const projects = await (await call('/v9/projects')).json() as CloudProjectListResponse;
  assert.equal(projects.projects[0].realtimeBaseVersionId,saved.version.id);
  const invitation = await invite(studio,'author');
  assert.equal((await call(`/v9/project-invitations/${invitation}/respond`,'author',{decision:'accept'})).status,200);
  const key = crypto.randomUUID(); body.parentVersionId=saved.version.id;
  assert.equal((await call('/v5/scenarios/sync','author',body,key)).status,201);
  await call(`/v6/studios/${studio}/members/${ids.author}/remove`,'studio',{});
  assert.equal((await call('/v5/scenarios/sync','author',body,key)).status,404);
});

it('separate ingress budget allows several authenticated subjects without relaxing their limits', async () => {
  const runtime = await createLocalRuntime({ rateLimiter: new InMemoryRateLimiter(1, 60000), ingressRateLimiter: new InMemoryRateLimiter(10, 60000) });
  const read = (p: string) => runtime.worker.fetch(new Request('http://localhost/v1/me', { headers: { Authorization: `Bearer local-test:${p}`, Origin: 'http://localhost:3000', 'cf-connecting-ip': '192.0.2.1' } }));
  assert.equal((await read('studio')).status, 200); assert.equal((await read('author')).status, 200);
  assert.equal((await read('studio')).status, 429);
});
