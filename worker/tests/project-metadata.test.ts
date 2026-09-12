/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHmac } from 'node:crypto';
import { metadataFixture, ids } from './metadataFixture.ts';
import {
  parseMetadataResponse,
  type MetadataWrite,
  type ProjectComment,
} from '../../lib/commercial/contracts-v10.ts';
const comment: ProjectComment = {
  id: 'thread_test',
  status: 'open',
  createdAt: '2026-09-12T00:00:00Z',
  resolvedAt: null,
  anchor: {
    sceneId: 'scene_root',
    blockId: 'block_one',
    startOffset: 0,
    endOffset: 5,
    originalText: 'SYNTHETIC_QUOTE',
    lost: false,
  },
  messages: [
    {
      id: 'message_one',
      text: 'SYNTHETIC_COMMENT',
      createdAt: '2026-09-12T00:00:00Z',
      editedAt: null,
    },
  ],
};
const write = (
  key: string,
  value: MetadataWrite['changes'][number]['value'],
  expectedRevision = 0,
): MetadataWrite => ({
  operationId: crypto.randomUUID(),
  changes: [{ key, value, expectedRevision }],
});
async function fixture() {
  const f = await metadataFixture(),
    id = await f.create('Metadata', {
      coverPage: { projectName: 'SYNTHETIC_COVER' },
      comments: [comment],
    }),
    studio = await f.share(id);
  for (const [profile, role] of [
    ['author', 'editor'],
    ['discovery', 'viewer'],
  ] as const) {
    const invitation = await f.invite(studio, profile, role);
    assert.equal(
      (
        await f.call(`/v9/project-invitations/${invitation}/respond`, profile, {
          decision: 'accept',
        })
      ).status,
      200,
    );
  }
  return { ...f, id, studio, path: `/v10/projects/${id}/metadata` };
}
it('v10 seeds the trusted file and merges concurrent independent cover/comment fields for three accounts', async () => {
  const f = await fixture();
  const seed = parseMetadataResponse(await (await f.call(f.path)).json());
  assert.equal(
    seed.state.registers['cover.projectName'].value,
    'SYNTHETIC_COVER',
  );
  assert.deepEqual(seed.state.registers['comment:thread_test'].value, comment);
  const replies = await Promise.all([
    f.call(f.path, 'studio', write('cover.director', 'SYNTHETIC_DIRECTOR')),
    f.call(f.path, 'author', write('cover.screenwriter', 'SYNTHETIC_AUTHOR')),
    f.call(
      f.path,
      'author',
      write('comment:thread_other', { ...comment, id: 'thread_other' }),
    ),
  ]);
  assert.ok(replies.every((r) => r.status === 200));
  for (const r of replies)
    assert.equal(parseMetadataResponse(await r.json()).status, 'applied');
  const viewer = parseMetadataResponse(
    await (await f.call(f.path, 'discovery')).json(),
  );
  assert.equal(viewer.state.revision, 3);
  assert.equal(
    viewer.state.registers['cover.director'].value,
    'SYNTHETIC_DIRECTOR',
  );
  assert.ok(viewer.state.registers['comment:thread_other']);
  assert.doesNotMatch(
    JSON.stringify(f.metrics),
    /SYNTHETIC_|example.invalid|local-test:|thread_other/,
  );
});
it('same field races have one winner; replay, uncertain retry and actor/content binding are deterministic', async () => {
  const f = await fixture(),
    a = write('cover.director', 'First'),
    b = write('cover.director', 'Second');
  const [ra, rb] = await Promise.all([
    f.call(f.path, 'studio', a),
    f.call(f.path, 'author', b),
  ]);
  const results = await Promise.all(
    [ra, rb].map(async (r) => parseMetadataResponse(await r.json())),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [
    'applied',
    'conflict',
  ]);
  const again = parseMetadataResponse(
    await (await f.call(f.path, 'studio', a)).json(),
  );
  assert.equal(again.replayed, true);
  assert.deepEqual(again.state, results[0].state);
  assert.equal(
    (
      await f.call(f.path, 'studio', {
        ...a,
        changes: [{ ...a.changes[0], value: 'Forged' }],
      })
    ).status,
    409,
  );
  const otherAccount = parseMetadataResponse(
    await (await f.call(f.path, 'author', a)).json(),
  );
  assert.equal(otherAccount.replayed, false);
  assert.equal(
    parseMetadataResponse(await (await f.call(f.path)).json()).state.revision,
    1,
  );
});
it('replies, edits, resolution and durable tombstones survive reads; snapshots freeze metadata idempotently', async () => {
  const f = await fixture();
  let thread = {
    ...comment,
    messages: [
      ...comment.messages,
      { ...comment.messages[0], id: 'message_reply', text: 'Reply' },
    ],
  };
  await f.call(f.path, 'author', write('comment:thread_test', thread));
  thread = {
    ...thread,
    messages: [
      { ...thread.messages[0], text: 'Edited' },
      ...thread.messages.slice(1),
    ],
  };
  await f.call(f.path, 'studio', write('comment:thread_test', thread, 1));
  const context = {
    profileId: ids.studio,
    emailHash: '',
    displayName: '',
    fingerprintHash: await sha('phase10-device-fingerprint-studio'),
    platform: 'windows' as const,
    clientVersion: '0.1.7',
  };
  const input = {
    context,
    scenarioId: f.id,
    requestId: crypto.randomUUID(),
    snapshotId: crypto.randomUUID(),
  };
  const first = await f.runtime.metadataRepository!.forSnapshot(input);
  assert.equal(
    (first.registers['comment:thread_test'].value as ProjectComment).messages
      .length,
    2,
  );
  await f.call(
    f.path,
    'author',
    write(
      'comment:thread_test',
      { ...thread, status: 'resolved', resolvedAt: new Date().toISOString() },
      2,
    ),
  );
  await f.call(f.path, 'studio', write('comment:thread_test', null, 3));
  assert.deepEqual(
    await f.runtime.metadataRepository!.forSnapshot(input),
    first,
  );
  const stale = parseMetadataResponse(
    await (
      await f.call(f.path, 'author', write('comment:thread_test', thread, 2))
    ).json(),
  );
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.state.registers['comment:thread_test'].value, null);
});
async function sha(text: string) {
  return createHmac('sha256', 'ephemeral-local-test-pepper')
    .update(text)
    .digest('hex');
}
it('viewer, outsider, revoked membership, inactive device, missing rights and expired session cannot mutate or replay', async () => {
  const f = await fixture(),
    body = write('cover.director', 'Forbidden');
  assert.equal((await f.call(f.path, 'discovery', body)).status, 404);
  const privateId = await f.create('Private');
  assert.equal(
    (await f.call(`/v10/projects/${privateId}/metadata`, 'author')).status,
    404,
  );
  assert.equal((await f.call(f.path, 'author', body)).status, 200);
  assert.equal(
    (
      await f.call(f.path, 'author', undefined, undefined, {
        'X-Scenario-Client-Version': '0.0.1',
      })
    ).status,
    426,
  );
  assert.equal(
    (
      await f.call(f.path, 'author', undefined, undefined, {
        'X-Scenario-Device-Fingerprint': 'inactive-device-fingerprint',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(f.path, 'author', body, undefined, {
        Authorization: 'Bearer invalid',
      })
    ).status,
    401,
  );
  await f.call(
    `/v6/studios/${f.studio}/members/${ids.author}/remove`,
    'studio',
    {},
  );
  assert.equal((await f.call(f.path, 'author', body)).status, 404);
  f.runtime.repository.grantEntitlements(ids.discovery, {
    configurationVersion: 'none',
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    offlineValidUntil: new Date().toISOString(),
    deviceLimit: 3,
    entitlements: [],
  });
  assert.equal((await f.call(f.path, 'discovery')).status, 403);
  await f.call(`/v5/scenarios/${f.id}/delete`, 'studio', {});
  assert.equal((await f.call(f.path)).status, 404);
});
it('bounded strict protocol rejects escalation, oversized payloads and malformed legacy metadata without discarding it', async () => {
  const f = await fixture();
  assert.equal(
    (
      await f.call(f.path, 'studio', {
        ...write('cover.director', 'X'),
        role: 'owner',
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.call(f.path, 'studio', write('cover.director', 'X'.repeat(4097))))
      .status,
    400,
  );
  assert.equal(
    (await f.call(f.path, 'studio', write('__proto__', 'X'))).status,
    400,
  );
  assert.equal(
    (
      await f.call(f.path, 'studio', write('cover.director', 'X'), undefined, {
        Origin: 'https://evil.invalid',
      })
    ).status,
    403,
  );
  const bad = await f.create('Malformed', { comments: [{ id: 'bad' }] });
  await f.share(bad);
  assert.equal((await f.call(`/v10/projects/${bad}/metadata`)).status, 409);
});
