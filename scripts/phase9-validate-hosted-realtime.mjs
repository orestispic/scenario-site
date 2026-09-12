import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseEnvironmentFile } from './phase9-preflight.mjs';
import { deterministicUuid } from './phase9-provision-studio-fixture.mjs';
import { accountDefinitions } from './phase9-provision-test-accounts.mjs';

const ORIGIN = 'http://127.0.0.1:1420';
const PLATFORM = 'windows';
const STORAGE_BUCKET = 'scenario-documents-preproduction';

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

export function collaborativeChecksum(operation) {
  return createHash('sha256').update(canonical(operation)).digest('hex');
}

function clientHeaders(session, fingerprint, clientVersion, idempotencyKey) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${session.accessToken}`,
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'X-Scenario-Device-Fingerprint': fingerprint,
    'X-Scenario-Platform': PLATFORM,
    'X-Scenario-Client-Version': clientVersion,
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

function adminHeaders(secretKey) {
  const headers = {
    Accept: 'application/json',
    apikey: secretKey,
  };
  if (!secretKey.startsWith('sb_secret_'))
    headers.Authorization = `Bearer ${secretKey}`;
  return headers;
}

async function ledgerRows(supabaseUrl, secretKey, table, parameters) {
  const query = new URLSearchParams(parameters);
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, {
    headers: adminHeaders(secretKey),
  });
  const payload = await readResponse(response);
  if (!response.ok || !Array.isArray(payload))
    throw new Error(`Hosted ${table} ledger verification failed.`);
  return payload;
}

async function storedObject(supabaseUrl, secretKey, storageKey) {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/authenticated/${STORAGE_BUCKET}/${storageKey}`,
    { headers: adminHeaders(secretKey) },
  );
  if (!response.ok)
    throw new Error('Hosted private collaboration snapshot is unavailable.');
  return new Uint8Array(await response.arrayBuffer());
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Hosted realtime returned non-JSON HTTP ${response.status}.`,
    );
  }
}

async function workerRequest(apiUrl, path, init) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const payload = await readResponse(response);
  if (!response.ok) {
    const code = typeof payload?.code === 'string' ? ` (${payload.code})` : '';
    throw new Error(
      `Hosted realtime failed with HTTP ${response.status}${code}.`,
    );
  }
  return { response, payload };
}

async function expectRejection(apiUrl, path, init, statuses, codes) {
  const expectedCodes = Array.isArray(codes) ? codes : [codes];
  const response = await fetch(`${apiUrl}${path}`, init);
  const payload = await readResponse(response);
  if (
    !statuses.includes(response.status) ||
    !expectedCodes.includes(payload?.code)
  )
    throw new Error(
      `Expected ${expectedCodes.join(' or ')} rejection, received HTTP ${response.status} (${String(payload?.code ?? 'no_code')}).`,
    );
}

async function serverMinimumVersion(apiUrl) {
  const { payload } = await workerRequest(apiUrl, '/v1/config', {
    headers: { Accept: 'application/json', Origin: ORIGIN },
  });
  const minimum =
    payload?.compatibility?.find((entry) => entry.platform === PLATFORM)
      ?.minimumSupportedVersion ??
    payload?.compatibility?.[0]?.minimumSupportedVersion;
  if (typeof minimum !== 'string')
    throw new Error('Hosted minimum Windows version is unavailable.');
  return minimum;
}

async function login(definition, credentials, supabaseUrl, anonKey) {
  const prefix = `PHASE9_${definition.role.toUpperCase()}`;
  const response = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: required(credentials, `${prefix}_EMAIL`),
        password: required(credentials, `${prefix}_PASSWORD`),
      }),
    },
  );
  const session = await readResponse(response);
  if (!response.ok || typeof session?.access_token !== 'string')
    throw new Error(`Synthetic ${definition.role} login failed.`);
  return { ...definition, accessToken: session.access_token };
}

async function logout(
  sessions,
  supabaseUrl,
  anonKey,
  apiUrl,
  clientVersion,
  projectRef,
) {
  await Promise.allSettled(
    sessions.map(async (session) => {
      const workerResponse = await fetch(`${apiUrl}/v1/auth/logout`, {
        method: 'POST',
        headers: clientHeaders(
          session,
          fingerprint(session.role, projectRef),
          clientVersion,
        ),
        body: '{}',
      });
      if (workerResponse.ok) return;
      await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${session.accessToken}`,
        },
      });
    }),
  );
}

function fingerprint(role, projectRef) {
  return `phase9-${role}-${projectRef}-device`;
}

async function activateDevice(apiUrl, session, clientVersion, projectRef) {
  const device = fingerprint(session.role, projectRef);
  await workerRequest(apiUrl, '/v1/devices/activate', {
    method: 'POST',
    headers: clientHeaders(session, device, clientVersion),
    body: JSON.stringify({
      fingerprint: device,
      label: `Phase 9 ${session.role}`,
      platform: PLATFORM,
    }),
  });
  return device;
}

async function realtimePost({
  apiUrl,
  studioId,
  action,
  session,
  device,
  clientVersion,
  body,
  key,
}) {
  return workerRequest(apiUrl, `/v7/studios/${studioId}/realtime/${action}`, {
    method: 'POST',
    headers: clientHeaders(session, device, clientVersion, key),
    body: JSON.stringify(body),
  });
}

async function connect(input, afterCursor = 0) {
  const ticket = await realtimePost({
    ...input,
    action: 'tickets',
    body: {},
    key: `phase9-realtime-ticket-${input.session.role}-${crypto.randomUUID()}`,
  });
  if (
    typeof ticket.payload?.ticket !== 'string' ||
    ticket.payload?.maximumUses !== 1
  )
    throw new Error(`Synthetic ${input.session.role} ticket is invalid.`);
  const connected = await realtimePost({
    ...input,
    action: 'connect',
    body: { ticket: ticket.payload.ticket, afterCursor },
    key: `phase9-realtime-connect-${input.session.role}-${crypto.randomUUID()}`,
  });
  if (
    connected.response.status !== 201 ||
    typeof connected.payload?.connectionId !== 'string' ||
    connected.payload?.role !== input.session.role
  )
    throw new Error(`Synthetic ${input.session.role} connection is invalid.`);
  return { ticket: ticket.payload.ticket, ...connected.payload };
}

async function disconnect(input, connectionId) {
  return realtimePost({
    ...input,
    action: 'disconnect',
    body: { connectionId },
    key: `phase9-realtime-disconnect-${input.session.role}-${crypto.randomUUID()}`,
  });
}

async function currentVersionId(apiUrl, scenarioId, session, device, version) {
  const { payload } = await workerRequest(
    apiUrl,
    `/v5/scenarios/${scenarioId}/versions`,
    { headers: clientHeaders(session, device, version) },
  );
  if (!Array.isArray(payload?.versions) || payload.versions.length === 0)
    throw new Error('The hosted scenario has no persistent base version.');
  const latest = [...payload.versions]
    .sort(
      (left, right) => Number(left.versionNumber) - Number(right.versionNumber),
    )
    .at(-1);
  if (typeof latest?.id !== 'string')
    throw new Error('The hosted base version is invalid.');
  return latest.id;
}

export async function validateHostedRealtime({ projectRef, apiUrl }) {
  accountDefinitions(projectRef);
  if (!/^https:\/\/[^/]+\.workers\.dev$/.test(apiUrl))
    throw new Error('A workers.dev test API URL is required.');
  const environment = parseEnvironmentFile(
    readFileSync(resolve('.env.phase9.local'), 'utf8'),
  );
  const credentials = parseEnvironmentFile(
    readFileSync(resolve('.env.phase9.accounts.local'), 'utf8'),
  );
  const fixture = parseEnvironmentFile(
    readFileSync(resolve('.env.phase9.studio.local'), 'utf8'),
  );
  const supabaseUrl = required(environment, 'SUPABASE_URL').replace(/\/$/, '');
  if (supabaseUrl !== `https://${projectRef}.supabase.co`)
    throw new Error('Refusing a Supabase project mismatch.');
  const anonKey = required(environment, 'SUPABASE_ANON_KEY');
  const secretKey =
    environment.SUPABASE_SECRET_KEY?.trim() ||
    environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secretKey) throw new Error('A Supabase server key is required.');
  const studioId = required(fixture, 'PHASE9_STUDIO_ID');
  const scenarioId = required(fixture, 'PHASE9_SCENARIO_ID');
  const clientVersion = await serverMinimumVersion(apiUrl);
  const sessions = [];
  const connections = [];
  try {
    for (const definition of accountDefinitions(projectRef))
      sessions.push(await login(definition, credentials, supabaseUrl, anonKey));
    const inputs = {};
    for (const session of sessions) {
      const device = await activateDevice(
        apiUrl,
        session,
        clientVersion,
        projectRef,
      );
      inputs[session.role] = {
        apiUrl,
        studioId,
        session,
        device,
        clientVersion,
      };
    }

    const currentCloudVersionId = await currentVersionId(
      apiUrl,
      scenarioId,
      inputs.owner.session,
      inputs.owner.device,
      clientVersion,
    );
    const operationId = deterministicUuid(
      `${projectRef}:phase9:hosted-realtime:operation:v1`,
    );
    const existingOperations = await ledgerRows(
      supabaseUrl,
      secretKey,
      'studio_collaboration_operations',
      {
        studio_id: `eq.${studioId}`,
        operation_id: `eq.${operationId}`,
        select: 'base_version_id',
        limit: '1',
      },
    );
    const baseVersionId =
      existingOperations[0]?.base_version_id ?? currentCloudVersionId;
    for (const role of ['owner', 'editor', 'viewer']) {
      const connection = await connect(inputs[role]);
      connections.push({ input: inputs[role], id: connection.connectionId });
      inputs[role].connection = connection;
    }

    await expectRejection(
      apiUrl,
      `/v7/studios/${studioId}/realtime/connect`,
      {
        method: 'POST',
        headers: clientHeaders(
          inputs.owner.session,
          inputs.owner.device,
          clientVersion,
          `phase9-realtime-ticket-reuse-${crypto.randomUUID()}`,
        ),
        body: JSON.stringify({
          ticket: inputs.owner.connection.ticket,
          afterCursor: 0,
        }),
      },
      [401],
      'collaboration_ticket_invalid',
    );

    const heartbeat = await realtimePost({
      ...inputs.owner,
      action: 'heartbeat',
      body: { connectionId: inputs.owner.connection.connectionId },
      key: `phase9-realtime-heartbeat-${crypto.randomUUID()}`,
    });
    const roles = new Set(
      heartbeat.payload?.presence?.map((entry) => entry.role),
    );
    if (
      roles.size !== 3 ||
      !['owner', 'editor', 'viewer'].every((role) => roles.has(role))
    )
      throw new Error(
        'Hosted presence does not contain the three synthetic roles.',
      );

    const unsignedOperation = {
      studioId,
      scenarioId,
      baseVersionId,
      operationId,
      clientSequence: 1,
      logicalClock: 1,
      mutation: {
        type: 'block.upsert',
        blockId: 'phase9-hosted-validation-block-v1',
        afterBlockId: null,
        block: {
          type: 'paragraph',
          attrs: { syntheticValidation: true },
          content: [],
        },
      },
    };
    const operation = {
      ...unsignedOperation,
      checksum: collaborativeChecksum(unsignedOperation),
    };
    const applied = await realtimePost({
      ...inputs.owner,
      action: 'operations',
      body: {
        connectionId: inputs.owner.connection.connectionId,
        operation,
      },
      key: `phase9-realtime-operation-${operationId}`,
    });
    if (!['applied', 'replayed'].includes(applied.payload?.status))
      throw new Error('Hosted owner operation was not applied or replayed.');
    const replayed = await realtimePost({
      ...inputs.owner,
      action: 'operations',
      body: {
        connectionId: inputs.owner.connection.connectionId,
        operation,
      },
      key: `phase9-realtime-operation-retry-${operationId}`,
    });
    if (replayed.payload?.status !== 'replayed')
      throw new Error('Hosted operation retry was not deduplicated.');

    await expectRejection(
      apiUrl,
      `/v7/studios/${studioId}/realtime/operations`,
      {
        method: 'POST',
        headers: clientHeaders(
          inputs.viewer.session,
          inputs.viewer.device,
          clientVersion,
          `phase9-realtime-viewer-refusal-${crypto.randomUUID()}`,
        ),
        body: JSON.stringify({
          connectionId: inputs.viewer.connection.connectionId,
          operation: {
            ...operation,
            operationId: deterministicUuid(
              `${projectRef}:phase9:hosted-realtime:viewer-refusal:v1`,
            ),
          },
        }),
      },
      [403, 404],
      ['studio_not_found', 'studio_write_forbidden'],
    );

    const poll = await realtimePost({
      ...inputs.editor,
      action: 'poll',
      body: {
        connectionId: inputs.editor.connection.connectionId,
        afterCursor: inputs.editor.connection.cursor,
      },
      key: `phase9-realtime-poll-${crypto.randomUUID()}`,
    });
    const events = poll.payload?.events;
    if (!Array.isArray(events)) throw new Error('Hosted poll is invalid.');
    if (
      events.some(
        (event, index) => index > 0 && event.cursor <= events[index - 1].cursor,
      ) ||
      !events.some(
        (event) =>
          event.type === 'operation.applied' &&
          event.operation?.operationId === operationId,
      )
    )
      throw new Error('Hosted cursor catch-up is not monotone or complete.');

    const persistedOperations = await ledgerRows(
      supabaseUrl,
      secretKey,
      'studio_collaboration_operations',
      {
        studio_id: `eq.${studioId}`,
        operation_id: `eq.${operationId}`,
        select: 'operation_id,checksum,cursor',
      },
    );
    if (
      persistedOperations.length !== 1 ||
      persistedOperations[0]?.checksum !== operation.checksum ||
      !Number.isSafeInteger(Number(persistedOperations[0]?.cursor))
    )
      throw new Error(
        'Hosted operation is not unique in the append-only ledger.',
      );
    const acknowledgements = await ledgerRows(
      supabaseUrl,
      secretKey,
      'studio_collaboration_acknowledgements',
      {
        studio_id: `eq.${studioId}`,
        cursor: `gte.${persistedOperations[0].cursor}`,
        select: 'cursor',
        limit: '1',
      },
    );
    if (acknowledgements.length !== 1)
      throw new Error('Hosted cursor acknowledgement was not persisted.');

    let snapshots = await ledgerRows(
      supabaseUrl,
      secretKey,
      'studio_collaboration_snapshots',
      {
        studio_id: `eq.${studioId}`,
        select:
          'id,version_id,parent_version_id,through_cursor,storage_key,checksum',
        order: 'created_at.desc',
        limit: '1',
      },
    );
    let compactionStatus = 'existing';
    if (snapshots.length === 0) {
      if (baseVersionId !== currentCloudVersionId)
        throw new Error('Hosted compaction parent is no longer current.');
      const compacted = await realtimePost({
        ...inputs.owner,
        action: 'compact',
        body: {
          connectionId: inputs.owner.connection.connectionId,
          parentVersionId: currentCloudVersionId,
        },
        key: 'phase9-realtime-compaction-v2-owner',
      });
      compactionStatus = compacted.payload?.replayed ? 'replayed' : 'created';
      snapshots = await ledgerRows(
        supabaseUrl,
        secretKey,
        'studio_collaboration_snapshots',
        {
          studio_id: `eq.${studioId}`,
          id: `eq.${compacted.payload?.snapshotId}`,
          select:
            'id,version_id,parent_version_id,through_cursor,storage_key,checksum',
        },
      );
      const snapshotPoll = await realtimePost({
        ...inputs.editor,
        action: 'poll',
        body: {
          connectionId: inputs.editor.connection.connectionId,
          afterCursor: poll.payload.nextCursor,
        },
        key: `phase9-realtime-snapshot-poll-${crypto.randomUUID()}`,
      });
      if (
        !snapshotPoll.payload?.events?.some(
          (event) =>
            event.type === 'snapshot.created' &&
            event.snapshotId === compacted.payload?.snapshotId,
        )
      )
        throw new Error('Hosted snapshot event was not reconciled.');
    }
    const snapshot = snapshots[0];
    if (
      !snapshot ||
      typeof snapshot.id !== 'string' ||
      typeof snapshot.version_id !== 'string' ||
      typeof snapshot.storage_key !== 'string' ||
      typeof snapshot.checksum !== 'string' ||
      Number(snapshot.through_cursor) < Number(persistedOperations[0].cursor)
    )
      throw new Error('Hosted append-only snapshot ledger is invalid.');
    const versions = await ledgerRows(
      supabaseUrl,
      secretKey,
      'cloud_scenario_versions',
      {
        scenario_id: `eq.${scenarioId}`,
        id: `eq.${snapshot.version_id}`,
        select: 'id,parent_version_id,content_checksum,storage_key',
      },
    );
    if (
      versions.length !== 1 ||
      versions[0]?.content_checksum !== snapshot.checksum ||
      versions[0]?.storage_key !== snapshot.storage_key
    )
      throw new Error('Hosted snapshot and cloud version do not match.');
    const snapshotBytes = await storedObject(
      supabaseUrl,
      secretKey,
      snapshot.storage_key,
    );
    if (
      createHash('sha256').update(snapshotBytes).digest('hex') !==
      snapshot.checksum
    )
      throw new Error('Hosted private snapshot checksum does not match.');
    const snapshotDocument = JSON.parse(
      new TextDecoder().decode(snapshotBytes),
    );
    if (snapshotDocument?.formatVersion !== 1)
      throw new Error('Hosted private snapshot format is invalid.');

    const ownerConnectionId = inputs.owner.connection.connectionId;
    await disconnect(inputs.owner, ownerConnectionId);
    connections.splice(
      connections.findIndex((entry) => entry.id === ownerConnectionId),
      1,
    );
    const resumed = await connect(inputs.owner, applied.payload.nextCursor);
    if (resumed.connectionId === ownerConnectionId)
      throw new Error('Hosted reconnect reused a closed connection.');
    connections.push({ input: inputs.owner, id: resumed.connectionId });

    return {
      clientVersion,
      initialOperationStatus: applied.payload.status,
      presenceRoles: roles.size,
      polledEvents: events.length,
      ledgerOperations: persistedOperations.length,
      compactionStatus,
      snapshotVersions: versions.length,
      resumedCursor: resumed.cursor,
    };
  } finally {
    await Promise.allSettled(
      connections.map(({ input, id }) => disconnect(input, id)),
    );
    await logout(
      sessions,
      supabaseUrl,
      anonKey,
      apiUrl,
      clientVersion,
      projectRef,
    );
  }
}

async function run() {
  const projectRef = argument('--project-ref');
  const apiUrl = argument('--api-url')?.replace(/\/$/, '');
  if (!projectRef || !apiUrl)
    throw new Error('--project-ref and --api-url are required.');
  const result = await validateHostedRealtime({ projectRef, apiUrl });
  console.log(`three-role presence verified (${result.presenceRoles})`);
  console.log(`operation ${result.initialOperationStatus}; retry replayed`);
  console.log(`monotone catch-up verified (${result.polledEvents} event(s))`);
  console.log(
    `append-only Supabase ledger verified (${result.ledgerOperations} operation)`,
  );
  console.log(
    `private snapshot ${result.compactionStatus}; cloud version verified (${result.snapshotVersions})`,
  );
  console.log(
    `disconnect and cursor resume verified (${result.resumedCursor})`,
  );
  console.log(
    `hosted realtime validation passed on client ${result.clientVersion}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : 'Hosted realtime validation failed.',
    );
    process.exitCode = 1;
  });
