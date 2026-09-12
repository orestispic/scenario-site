import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { parseEnvironmentFile } from './phase9-preflight.mjs';
import { collaborativeChecksum } from './phase9-validate-hosted-realtime.mjs';

const projectRef = 'zblnsdyaoljnezxdidtx';
const apiUrl =
  'https://scenario-commercial-api-preproduction.ore-picard.workers.dev';
const env = parseEnvironmentFile(readFileSync('.env.phase9.local', 'utf8'));
const accounts = parseEnvironmentFile(
  readFileSync('.env.phase9.accounts.local', 'utf8'),
);
assert.equal(
  env.SUPABASE_URL.replace(/\/$/, ''),
  `https://${projectRef}.supabase.co`,
);
assert.equal(
  readFileSync('supabase/.temp/project-ref', 'utf8').trim(),
  projectRef,
);
if (!process.argv.includes('--execute'))
  throw new Error(
    'Pass --execute to create isolated synthetic projects and move them to trash at the end.',
  );
const sessions = new Map();
const created = [];
const channels = [];
const origin = 'http://127.0.0.1:1420';
const hash = (v) => createHash('sha256').update(v).digest('hex');
let version;
let failure;
async function call(
  path,
  role,
  body,
  key = randomUUID(),
  expected = [200, 201, 204],
) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      Authorization: `Bearer ${sessions.get(role)}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'X-Scenario-Client-Version': version,
      'X-Scenario-Platform': 'windows',
      'X-Scenario-Device-Fingerprint': `phase9-${role}-${projectRef}-device`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!expected.includes(response.status)) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `Hosted metadata ${role} ${path.replace(/[0-9a-f-]{36}/g, ':id')} HTTP ${response.status} (${String(error.code ?? 'unknown')})`,
    );
  }
  return response.status === 204 ? null : response.json();
}
try {
  const config = await (
    await fetch(`${apiUrl}/v1/config`, {
      headers: { Origin: origin },
      signal: AbortSignal.timeout(15000),
    })
  ).json();
  assert.equal(config.environment, 'staging');
  version =
    config.compatibility.find((v) => v.platform === 'windows')
      ?.minimumSupportedVersion ??
    config.compatibility[0]?.minimumSupportedVersion;
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  for (const role of ['owner', 'editor', 'viewer']) {
    const prefix = `PHASE9_${role.toUpperCase()}`;
    assert.equal(
      accounts[`${prefix}_EMAIL`],
      `phase9-${role}-${projectRef}@example.com`,
    );
    const response = await fetch(
      `${env.SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: accounts[`${prefix}_EMAIL`],
          password: accounts[`${prefix}_PASSWORD`],
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    assert.equal(response.status, 200, `${role} login`);
    sessions.set(role, (await response.json()).access_token);
  }

  const id = randomUUID(),
    title = 'Validation commentaires et premières pages';
  const comment = {
    id: 'thread_synthetic',
    status: 'open',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    anchor: {
      sceneId: 'scene_root',
      blockId: 'block_synthetic',
      startOffset: 0,
      endOffset: 5,
      originalText: 'Hello',
      lost: false,
    },
    messages: [
      {
        id: 'message_initial',
        text: 'Initial synthetic comment',
        createdAt: new Date().toISOString(),
        editedAt: null,
      },
    ],
  };
  const content = JSON.stringify({
    formatVersion: 1,
    title,
    coverPage: { projectName: 'Initial first page' },
    coverPageHidden: false,
    comments: [comment],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'block_synthetic', scenarioType: 'ACTION' },
          content: [{ type: 'text', text: 'Hello synthetic project' }],
        },
      ],
    },
  });
  const initial = await call(
    '/v5/scenarios/sync',
    'owner',
    {
      scenarioId: id,
      title,
      parentVersionId: null,
      checksum: hash(content),
      sizeBytes: Buffer.byteLength(content),
      contentType: 'application/vnd.scenario+json',
      format: 'scenario-v1',
      origin: 'save',
      content,
    },
    id,
  );
  created.push(id);
  const studioId = (await call(`/v9/projects/${id}/sharing`, 'owner', {}, id))
    .studio.id;
  for (const role of ['editor', 'viewer']) {
    const invitation = await call(
      `/v6/studios/${studioId}/invitations`,
      'owner',
      { email: accounts[`PHASE9_${role.toUpperCase()}_EMAIL`], role },
    );
    await call(
      `/v9/project-invitations/${invitation.invitation.id}/respond`,
      role,
      { decision: 'accept' },
    );
  }
  const path = `/v10/projects/${id}/metadata`,
    write = (key, value, expectedRevision = 0) => ({
      operationId: randomUUID(),
      changes: [{ key, value, expectedRevision }],
    });
  const seed = await call(path, 'viewer');
  assert.equal(seed.contractVersion, '2026-09-v10');
  assert.equal(
    seed.state.registers['cover.projectName'].value,
    'Initial first page',
  );
  assert.deepEqual(
    seed.state.registers['comment:thread_synthetic'].value,
    comment,
  );
  const results = await Promise.all([
    call(path, 'owner', write('cover.director', 'Synthetic director')),
    call(path, 'editor', write('cover.screenwriter', 'Synthetic screenwriter')),
  ]);
  assert.ok(results.every((r) => r.status === 'applied'));
  const race = await Promise.all([
    call(path, 'owner', write('cover.production', 'A')),
    call(path, 'editor', write('cover.production', 'B')),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort((a,b) => a.localeCompare(b)), ['applied', 'conflict']);
  const replied = {
      ...comment,
      messages: [
        ...comment.messages,
        {
          ...comment.messages[0],
          id: 'message_reply',
          text: 'Synthetic reply',
        },
      ],
    },
    body = write('comment:thread_synthetic', replied);
  const reply = await call(path, 'editor', body),
    replay = await call(path, 'editor', body);
  assert.equal(reply.status, 'applied');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.state, reply.state);
  await call(
    path,
    'editor',
    { ...body, changes: [{ ...body.changes[0], value: null }] },
    randomUUID(),
    [409],
  );
  await call(
    path,
    'viewer',
    write('cover.director', 'Forbidden'),
    randomUUID(),
    [404],
  );
  let current = await call(path, 'viewer');
  assert.equal(
    current.state.registers['cover.director'].value,
    'Synthetic director',
  );
  assert.equal(
    current.state.registers['cover.screenwriter'].value,
    'Synthetic screenwriter',
  );
  assert.equal(
    current.state.registers['comment:thread_synthetic'].value.messages.length,
    2,
  );
  console.log(
    'PASS hosted metadata: trusted private-file seed, three accounts, concurrent fields, same-field conflict, replies, exact replay and viewer denial.',
  );
  const prefix = `/v7/studios/${studioId}/realtime`;
  for (const role of ['owner', 'editor']) {
    const ticket = await call(`${prefix}/tickets`, role, {});
    const connection = await call(`${prefix}/connect`, role, {
      ticket: ticket.ticket,
      afterCursor: 0,
    });
    channels.push({ role, prefix, connectionId: connection.connectionId });
  }
  const ops = await Promise.all(
    channels.map(async (channel, index) => {
      const blockId = `block_extra_${index}`,
        unsigned = {
          studioId,
          scenarioId: id,
          baseVersionId: initial.version.id,
          operationId: randomUUID(),
          clientSequence: 1,
          logicalClock: 1,
          mutation: {
            type: 'block.upsert',
            blockId,
            afterBlockId: 'block_synthetic',
            block: {
              type: 'paragraph',
              attrs: { blockId, scenarioType: 'ACTION' },
              content: [
                { type: 'text', text: 'Synthetic concurrent text ' + index },
              ],
            },
          },
        };
      const operation = {
        ...unsigned,
        checksum: collaborativeChecksum(unsigned),
      };
      assert.equal(
        (
          await call(`${prefix}/operations`, channel.role, {
            connectionId: channel.connectionId,
            operation,
          })
        ).status,
        'applied',
      );
      return operation;
    }),
  );
  for (const channel of channels) {
    const polled = await call(`${prefix}/poll`, channel.role, {
      connectionId: channel.connectionId,
      afterCursor: 0,
    });
    assert.ok(
      ops.every((op) =>
        polled.events.some(
          (e) =>
            e.type === 'operation.applied' &&
            e.operation.operationId === op.operationId,
        ),
      ),
    );
  }
  const key = randomUUID(),
    compactBody = {
      connectionId: channels[0].connectionId,
      parentVersionId: initial.version.id,
    };
  const compact = await call(`${prefix}/compact`, 'owner', compactBody, key);
  assert.equal(
    (await call(`${prefix}/compact`, 'owner', compactBody, key)).snapshotId,
    compact.snapshotId,
  );
  const versions = (await call(`/v5/scenarios/${id}/versions`, 'viewer'))
    .versions;
  const snapshot = versions.find((v) => v.id === compact.versionId);
  assert.ok(snapshot);
  assert.equal(snapshot.parentVersionId, initial.version.id);
  const grant = (
    await call(
      `/v5/scenarios/${id}/versions/${compact.versionId}/download`,
      'viewer',
    )
  ).download;
  assert.equal(new URL(grant.url).origin, env.SUPABASE_URL.replace(/\/$/, ''));
  const download = await fetch(grant.url, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(hash(bytes), snapshot.checksum);
  const full = JSON.parse(bytes.toString());
  assert.equal(full.coverPage.director, 'Synthetic director');
  assert.equal(full.coverPage.screenwriter, 'Synthetic screenwriter');
  assert.equal(full.comments[0].messages.length, 2);
  assert.ok(
    JSON.stringify(full.content).includes('Synthetic concurrent text 0'),
  );
  assert.ok(
    JSON.stringify(full.content).includes('Synthetic concurrent text 1'),
  );
  assert.equal(full.projectMetadataRevision, current.state.revision);
  current = await call(path, 'owner');
  await call(
    path,
    'owner',
    write(
      'comment:thread_synthetic',
      null,
      current.state.registers['comment:thread_synthetic'].revision,
    ),
  );
  const redownload = await fetch(grant.url, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(
    hash(Buffer.from(await redownload.arrayBuffer())),
    snapshot.checksum,
    'old snapshot changed after comment deletion',
  );
  const editorId = (await call('/v1/me', 'editor')).account.id;
  await call(`/v6/studios/${studioId}/members/${editorId}/remove`, 'owner', {});
  await call(path, 'editor', body, randomUUID(), [404]);
  await call(path, 'editor', undefined, randomUUID(), [404]);
  console.log(
    'PASS hosted text + metadata: concurrent real channel, private snapshot contains cover/comments/replies and both text edits, checksum/parent/replay, immutable old snapshot after deletion and revoked replay denied.',
  );
} catch (error) {
  failure = error;
} finally {
  let cleanupFailed = false;
  await Promise.allSettled(
    channels.map((channel) =>
      call(
        `${channel.prefix}/disconnect`,
        channel.role,
        { connectionId: channel.connectionId },
        randomUUID(),
        [200, 403, 404],
      ),
    ),
  );
  for (const id of created) {
    try {
      await call(`/v5/scenarios/${id}/delete`, 'owner', {});
    } catch {
      cleanupFailed = true;
    }
  }
  await Promise.allSettled(
    [...sessions.values()].map((token) =>
      fetch(`${env.SUPABASE_URL}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10000),
      }),
    ),
  );
  if (cleanupFailed)
    failure ??= new Error(
      'Synthetic cleanup incomplete; inspect the metadata test projects.',
    );
  console.log(
    `Synthetic projects moved to trash: ${created.length}; append-only history retained. Test sessions closed.`,
  );
}
if (failure) throw failure;
