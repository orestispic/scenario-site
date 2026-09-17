import type {
  LocalTestRepository,
  LocalTestProfile,
} from './localTestRepository.ts';

export const LOCAL_DEMO_SCENARIO_ID = '90000000-0000-4000-8000-000000000001';
export const LOCAL_DEMO_STUDIO_NAME = 'Studio de démonstration';

const PROFILE_IDS: Record<LocalTestProfile, string> = {
  discovery: '10000000-0000-4000-8000-000000000001',
  author: '10000000-0000-4000-8000-000000000002',
  studio: '10000000-0000-4000-8000-000000000003',
};
const SEED_DEVICES: Record<LocalTestProfile, string> = {
  discovery: 'local-demo-discovery-device-00001',
  author: 'local-demo-author-device-0000001',
  studio: 'local-demo-studio-device-0000001',
};
const LOCAL_PROFILES: LocalTestProfile[] = ['discovery', 'author', 'studio'];

type LocalDemoRuntime = {
  repository: LocalTestRepository;
  worker: { fetch(request: Request): Promise<Response> };
};

async function checksum(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function demoRequest(
  runtime: LocalDemoRuntime,
  path: string,
  profile: LocalTestProfile,
  body?: unknown,
  idempotencyKey = crypto.randomUUID(),
) {
  return runtime.worker.fetch(
    new Request(`http://127.0.0.1:1420${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer local-test:${profile}`,
        Origin: 'http://127.0.0.1:1420',
        'X-Scenario-Client-Version': '0.1.7',
        'X-Scenario-Device-Fingerprint': SEED_DEVICES[profile],
        'X-Scenario-Platform': 'windows',
        ...(body === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function requireSuccess(response: Response, operation: string) {
  if (!response.ok)
    throw new Error(
      `Échec de la fixture locale (${operation}, HTTP ${response.status}): ${await response.text()}`,
    );
  return response;
}

async function activateSeedDevices(runtime: LocalDemoRuntime) {
  for (const profile of LOCAL_PROFILES)
    await requireSuccess(
      await demoRequest(runtime, '/v1/devices/activate', profile, {
        fingerprint: SEED_DEVICES[profile],
        label: 'Initialisation Studio de démonstration',
        platform: 'windows',
      }),
      `activation ${profile}`,
    );
}

async function removeSeedDevices(runtime: LocalDemoRuntime) {
  for (const profile of LOCAL_PROFILES) {
    const devices = await runtime.repository.listDevices(PROFILE_IDS[profile]);
    for (const device of devices.filter(
      (candidate) =>
        candidate.label === 'Initialisation Studio de démonstration',
    ))
      runtime.repository.removeLocalFixtureDevice(
        PROFILE_IDS[profile],
        device.id,
      );
  }
}

function grantDemoCollaboration(runtime: LocalDemoRuntime) {
  const issuedAt = new Date().toISOString();
  const offlineValidUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
  for (const profile of ['discovery', 'author'] as const)
    runtime.repository.grantEntitlements(PROFILE_IDS[profile], {
      configurationVersion: 'local-demo-v1',
      issuedAt,
      expiresAt: null,
      offlineValidUntil,
      deviceLimit: 2,
      entitlements: [
        { code: 'local.edit', enabled: true, value: null },
        { code: 'cloud.sync', enabled: true, value: null },
        { code: 'cloud_sync', enabled: true, value: null },
        { code: 'scenario_versions', enabled: true, value: null },
        { code: 'studio_collaboration', enabled: true, value: null },
      ],
    });
}

async function addMember(
  runtime: LocalDemoRuntime,
  studioId: string,
  profile: 'author' | 'discovery',
  role: 'editor' | 'viewer',
) {
  await requireSuccess(
    await demoRequest(
      runtime,
      `/v6/studios/${studioId}/invitations`,
      'studio',
      { email: `${profile}@example.invalid`, role },
      `local-demo-invite-${profile}-000001`,
    ),
    `invitation ${profile}`,
  );
  const invitationsResponse = await requireSuccess(
    await demoRequest(runtime, '/v6/studios', profile),
    `lecture invitation ${profile}`,
  );
  const invitations = (await invitationsResponse.json()) as {
    receivedInvitations: Array<{
      studioId: string;
      developmentToken?: string;
    }>;
  };
  const token = invitations.receivedInvitations.find(
    (invitation) => invitation.studioId === studioId,
  )?.developmentToken;
  if (!token)
    throw new Error(`Jeton local de démonstration absent (${profile}).`);
  await requireSuccess(
    await demoRequest(
      runtime,
      '/v6/studio-invitations/accept',
      profile,
      { token },
      `local-demo-accept-${profile}-000001`,
    ),
    `acceptation ${profile}`,
  );
}

async function addContact(runtime: LocalDemoRuntime, profile: 'author' | 'discovery') {
  await requireSuccess(
    await demoRequest(runtime, '/v15/contact-requests', 'studio', { email: `${profile}@example.invalid` }),
    `demande de contact ${profile}`,
  );
  const list = await requireSuccess(await demoRequest(runtime, '/v15/contacts', profile), `lecture des contacts ${profile}`);
  const requests = (await list.json()) as { receivedRequests: Array<{ id: string; profileId: string }> };
  const request = requests.receivedRequests.find((item) => item.profileId === PROFILE_IDS.studio);
  if (!request) throw new Error(`Demande de contact locale absente (${profile}).`);
  await requireSuccess(
    await demoRequest(runtime, `/v15/contact-requests/${request.id}/respond`, profile, { decision: 'accept' }),
    `acceptation du contact ${profile}`,
  );
}

/** Seeds only the isolated local-test Worker. No production entry point imports it. */
export async function seedLocalDemoStudio(runtime: LocalDemoRuntime) {
  grantDemoCollaboration(runtime);
  await activateSeedDevices(runtime);
  try {
    const content = JSON.stringify({
      formatVersion: 1,
      title: 'Scénario de démonstration',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Bienvenue dans le Studio.' }],
          },
        ],
      },
    });
    await requireSuccess(
      await demoRequest(
        runtime,
        '/v5/scenarios/sync',
        'studio',
        {
          scenarioId: LOCAL_DEMO_SCENARIO_ID,
          title: 'Scénario de démonstration',
          parentVersionId: null,
          checksum: await checksum(content),
          sizeBytes: new TextEncoder().encode(content).byteLength,
          contentType: 'application/vnd.scenario+json',
          format: 'scenario-v1',
          origin: 'save',
          content,
        },
        'local-demo-cloud-root-00000001',
      ),
      'création du scénario',
    );
    const createdResponse = await requireSuccess(
      await demoRequest(
        runtime,
        '/v6/studios',
        'studio',
        {
          scenarioId: LOCAL_DEMO_SCENARIO_ID,
          name: LOCAL_DEMO_STUDIO_NAME,
        },
        'local-demo-studio-create-000001',
      ),
      'création du Studio',
    );
    const { studio } = (await createdResponse.json()) as {
      studio: { id: string };
    };
    await addContact(runtime, 'author');
    await addContact(runtime, 'discovery');
    await addMember(runtime, studio.id, 'author', 'editor');
    await addMember(runtime, studio.id, 'discovery', 'viewer');
    return { studioId: studio.id, scenarioId: LOCAL_DEMO_SCENARIO_ID };
  } finally {
    await removeSeedDevices(runtime);
  }
}
