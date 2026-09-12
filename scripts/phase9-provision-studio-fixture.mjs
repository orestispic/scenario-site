import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseEnvironmentFile } from './phase9-preflight.mjs';
import { accountDefinitions } from './phase9-provision-test-accounts.mjs';

const ORIGIN = 'http://127.0.0.1:1420';
const PLATFORM = 'windows';

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function adminHeaders(secretKey) {
  const headers = {
    Accept: 'application/json',
    apikey: secretKey,
    'Content-Type': 'application/json',
  };
  if (!secretKey.startsWith('sb_secret_'))
    headers.Authorization = `Bearer ${secretKey}`;
  return headers;
}

async function adminRequest(baseUrl, secretKey, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...adminHeaders(secretKey),
      ...init.headers,
    },
  });
  if (!response.ok)
    throw new Error(`Supabase fixture request failed with HTTP ${response.status}.`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function restPath(table, parameters) {
  const query = new URLSearchParams(parameters);
  return `/rest/v1/${table}?${query}`;
}

export function deterministicUuid(label) {
  const bytes = createHash('sha256').update(label).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function serverCatalogue(apiUrl) {
  const response = await fetch(`${apiUrl}/v1/config`, {
    headers: { Accept: 'application/json', Origin: ORIGIN },
  });
  if (!response.ok)
    throw new Error(`Worker catalogue failed with HTTP ${response.status}.`);
  const catalogue = await response.json();
  const minimum = catalogue.compatibility?.[0]?.minimumSupportedVersion;
  if (catalogue.version === 'unconfigured' || typeof minimum !== 'string')
    throw new Error('Worker catalogue or client compatibility is unavailable.');
  return minimum;
}

async function resolveProfiles({
  definitions,
  credentials,
  supabaseUrl,
  secretKey,
}) {
  const profiles = [];
  for (const definition of definitions) {
    const prefix = `PHASE9_${definition.role.toUpperCase()}`;
    const authUserId = required(credentials, `${prefix}_USER_ID`);
    const rows = await adminRequest(
      supabaseUrl,
      secretKey,
      restPath('profiles', {
        auth_user_id: `eq.${authUserId}`,
        select: 'id,auth_user_id,email,role,deleted_at',
        limit: '1',
      }),
    );
    const profile = rows[0];
    if (
      !profile ||
      profile.email?.toLowerCase() !== definition.email ||
      profile.role !== 'customer' ||
      profile.deleted_at !== null
    )
      throw new Error(`Synthetic ${definition.role} profile does not match.`);
    profiles.push({ ...definition, profileId: profile.id, authUserId });
  }
  return profiles;
}

async function grantStudioFixture({
  profiles,
  supabaseUrl,
  secretKey,
}) {
  const [configuration] = await adminRequest(
    supabaseUrl,
    secretKey,
    restPath('offer_configuration_versions', {
      status: 'eq.active',
      select: 'id,version_number',
      order: 'effective_at.desc',
      limit: '1',
    }),
  );
  const [offer] = await adminRequest(
    supabaseUrl,
    secretKey,
    restPath('offers', {
      offer_code: 'eq.studio',
      select: 'id',
      limit: '1',
    }),
  );
  if (!configuration || !offer)
    throw new Error('The active Studio catalogue is unavailable.');
  const [item] = await adminRequest(
    supabaseUrl,
    secretKey,
    restPath('offer_configuration_items', {
      configuration_version_id: `eq.${configuration.id}`,
      offer_id: `eq.${offer.id}`,
      billing_period: 'eq.month',
      select: 'device_limit,offline_grace_days',
      limit: '1',
    }),
  );
  const entitlements = await adminRequest(
    supabaseUrl,
    secretKey,
    restPath('offer_entitlements', {
      configuration_version_id: `eq.${configuration.id}`,
      offer_id: `eq.${offer.id}`,
      select: 'entitlement_code,value',
      order: 'entitlement_code.asc',
    }),
  );
  const quotas = await adminRequest(
    supabaseUrl,
    secretKey,
    restPath('offer_quotas', {
      configuration_version_id: `eq.${configuration.id}`,
      offer_id: `eq.${offer.id}`,
      select: 'quota_code,limit_value,period',
      order: 'quota_code.asc',
    }),
  );
  if (!item || entitlements.length === 0)
    throw new Error('The Studio catalogue has no server-side rights.');

  const now = new Date();
  const fixtureDay = now.toISOString().slice(0, 10);
  const validUntil = new Date(
    now.getTime() + Number(item.offline_grace_days) * 86_400_000,
  ).toISOString();
  const payload = {
    entitlements: entitlements.map((entry) => ({
      code: entry.entitlement_code,
      enabled: true,
      value: entry.value,
    })),
    quota_limits: Object.fromEntries(
      quotas.map((quota) => [quota.quota_code, quota.limit_value]),
    ),
    quota_periods: Object.fromEntries(
      quotas.map((quota) => [quota.quota_code, quota.period]),
    ),
    device_limit: item.device_limit,
    offline_valid_until: validUntil,
  };
  const missing = [];
  for (const profile of profiles) {
    const sourceEventId = `phase9-studio-fixture-v1:${fixtureDay}:${profile.profileId}`;
    const existing = await adminRequest(
      supabaseUrl,
      secretKey,
      restPath('entitlement_snapshots', {
        source_event_id: `eq.${sourceEventId}`,
        select: 'id',
        limit: '1',
      }),
    );
    if (existing.length === 0)
      missing.push({
        user_id: profile.profileId,
        configuration_version_id: configuration.id,
        source: 'admin_grant',
        effective_at: now.toISOString(),
        expires_at: validUntil,
        payload,
        source_event_id: sourceEventId,
      });
  }
  if (missing.length > 0)
    await adminRequest(supabaseUrl, secretKey, '/rest/v1/entitlement_snapshots', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(missing),
    });
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
  if (!response.ok)
    throw new Error(`Synthetic ${definition.role} login failed.`);
  const session = await response.json();
  if (typeof session.access_token !== 'string')
    throw new Error(`Synthetic ${definition.role} session is invalid.`);
  return { ...definition, accessToken: session.access_token };
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

async function workerRequest(apiUrl, path, init) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const code = typeof payload?.code === 'string' ? ` (${payload.code})` : '';
    throw new Error(`Worker fixture request failed with HTTP ${response.status}${code}.`);
  }
  return payload;
}

async function expectWorkerRejection(
  apiUrl,
  path,
  init,
  expectedStatuses,
  expectedCode,
) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const payload = await response.json();
  if (
    !expectedStatuses.includes(response.status) ||
    payload.code !== expectedCode
  )
    throw new Error(`Expected ${expectedCode} rejection was not enforced.`);
}

async function activateDevices(sessions, apiUrl, clientVersion, projectRef) {
  const devices = {};
  for (const session of sessions) {
    const fingerprint = `phase9-${session.role}-${projectRef}-device`;
    await workerRequest(apiUrl, '/v1/devices/activate', {
      method: 'POST',
      headers: clientHeaders(session, fingerprint, clientVersion),
      body: JSON.stringify({
        fingerprint,
        label: `Phase 9 ${session.role}`,
        platform: PLATFORM,
      }),
    });
    devices[session.role] = fingerprint;
  }
  return devices;
}

async function createStudio({
  sessions,
  devices,
  apiUrl,
  clientVersion,
  projectRef,
  invitationPepper,
}) {
  const owner = sessions.find((session) => session.role === 'owner');
  const scenarioId = deterministicUuid(`${projectRef}:phase9:scenario:v1`);
  const content = JSON.stringify({
    formatVersion: 1,
    title: 'Scénario de démonstration',
    blocks: [],
  });
  const checksum = createHash('sha256').update(content).digest('hex');
  const sync = await workerRequest(apiUrl, '/v5/scenarios/sync', {
    method: 'POST',
    headers: clientHeaders(
      owner,
      devices.owner,
      clientVersion,
      'phase9-studio-sync-v1-owner',
    ),
    body: JSON.stringify({
      scenarioId,
      title: 'Scénario de démonstration',
      parentVersionId: null,
      checksum,
      sizeBytes: Buffer.byteLength(content),
      contentType: 'application/vnd.scenario+json',
      format: 'scenario-v1',
      origin: 'save',
      content,
    }),
  });
  const studio = await workerRequest(apiUrl, '/v6/studios', {
    method: 'POST',
    headers: clientHeaders(
      owner,
      devices.owner,
      clientVersion,
      'phase9-studio-create-v1-owner',
    ),
    body: JSON.stringify({
      scenarioId: sync.scenario.id,
      name: 'Studio de démonstration',
    }),
  });

  for (const role of ['editor', 'viewer']) {
    const member = sessions.find((session) => session.role === role);
    const idempotencyKey = `phase9-studio-invite-v1-${role}`;
    await workerRequest(
      apiUrl,
      `/v6/studios/${studio.studio.id}/invitations`,
      {
        method: 'POST',
        headers: clientHeaders(
          owner,
          devices.owner,
          clientVersion,
          idempotencyKey,
        ),
        body: JSON.stringify({ email: member.email, role }),
      },
    );
    const digest = createHmac('sha256', invitationPepper)
      .update(`${studio.studio.id}:${idempotencyKey}`)
      .digest('hex');
    const token = `${studio.studio.id}.${digest}`;
    await workerRequest(apiUrl, '/v6/studio-invitations/accept', {
      method: 'POST',
      headers: clientHeaders(
        member,
        devices[role],
        clientVersion,
        `phase9-studio-accept-v1-${role}`,
      ),
      body: JSON.stringify({ token }),
    });
  }
  return { scenarioId: sync.scenario.id, studioId: studio.studio.id };
}

async function validateMemberships({
  sessions,
  profiles,
  devices,
  apiUrl,
  clientVersion,
  studioId,
}) {
  for (const session of sessions) {
    const payload = await workerRequest(apiUrl, `/v6/studios/${studioId}`, {
      headers: clientHeaders(
        session,
        devices[session.role],
        clientVersion,
      ),
    });
    if (payload.studio?.role !== session.role)
      throw new Error(`Synthetic ${session.role} membership does not match.`);
  }
  const viewer = sessions.find((session) => session.role === 'viewer');
  const viewerProfile = profiles.find((profile) => profile.role === 'viewer');
  await expectWorkerRejection(
    apiUrl,
    `/v6/studios/${studioId}/members/${viewerProfile.profileId}/role`,
    {
      method: 'POST',
      headers: clientHeaders(
        viewer,
        devices.viewer,
        clientVersion,
        'phase9-viewer-self-elevation-v1',
      ),
      body: JSON.stringify({ role: 'owner' }),
    },
    [403, 404],
    'studio_not_found',
  );
  const owner = sessions.find((session) => session.role === 'owner');
  await expectWorkerRejection(
    apiUrl,
    '/v6/studios',
    {
      headers: clientHeaders(owner, devices.owner, '0.1.6'),
    },
    [426],
    'client_update_required',
  );
}

async function logoutSessions(sessions, supabaseUrl, anonKey) {
  await Promise.allSettled(
    sessions.map((session) =>
      fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${session.accessToken}`,
        },
      }),
    ),
  );
}

async function run() {
  const projectRef = argument('--project-ref');
  const apiUrl = argument('--api-url')?.replace(/\/$/, '');
  if (!projectRef || !apiUrl)
    throw new Error('--project-ref and --api-url are required.');
  accountDefinitions(projectRef);
  const expectedSupabaseUrl = `https://${projectRef}.supabase.co`;
  const environment = parseEnvironmentFile(
    readFileSync(resolve('.env.phase9.local'), 'utf8'),
  );
  const credentials = parseEnvironmentFile(
    readFileSync(resolve('.env.phase9.accounts.local'), 'utf8'),
  );
  const supabaseUrl = required(environment, 'SUPABASE_URL').replace(/\/$/, '');
  if (supabaseUrl !== expectedSupabaseUrl)
    throw new Error(`Refusing project mismatch; expected ${expectedSupabaseUrl}.`);
  const secretKey =
    environment.SUPABASE_SECRET_KEY?.trim() ||
    environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secretKey) throw new Error('A Supabase server key is required.');
  const anonKey = required(environment, 'SUPABASE_ANON_KEY');
  const definitions = accountDefinitions(projectRef);
  const profiles = await resolveProfiles({
    definitions,
    credentials,
    supabaseUrl,
    secretKey,
  });
  await grantStudioFixture({ profiles, supabaseUrl, secretKey });
  const clientVersion = await serverCatalogue(apiUrl);
  const sessions = [];
  try {
    for (const definition of definitions)
      sessions.push(
        await login(definition, credentials, supabaseUrl, anonKey),
      );
    const devices = await activateDevices(
      sessions,
      apiUrl,
      clientVersion,
      projectRef,
    );
    const fixture = await createStudio({
      sessions,
      devices,
      apiUrl,
      clientVersion,
      projectRef,
      invitationPepper: required(environment, 'STUDIO_INVITATION_PEPPER'),
    });
    await validateMemberships({
      sessions,
      profiles,
      devices,
      apiUrl,
      clientVersion,
      studioId: fixture.studioId,
    });
    writeFileSync(
      resolve('.env.phase9.studio.local'),
      `PHASE9_SCENARIO_ID=${fixture.scenarioId}\nPHASE9_STUDIO_ID=${fixture.studioId}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    console.log('owner: active Studio membership verified');
    console.log('editor: active Studio membership verified');
    console.log('viewer: active Studio membership verified');
    console.log('viewer elevation and outdated client were rejected');
    console.log('Hosted Studio fixture is ready.');
  } finally {
    await logoutSessions(sessions, supabaseUrl, anonKey);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Fixture failed.');
    process.exitCode = 1;
  });
