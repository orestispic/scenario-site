/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LOCAL_DEMO_SCENARIO_ID,
  LOCAL_DEMO_STUDIO_NAME,
  seedLocalDemoStudio,
} from '../src/localDemoFixture.ts';
import { createLocalRuntime } from '../src/localRuntime.ts';
import type { LocalTestProfile } from '../src/localTestRepository.ts';

const PROFILES: LocalTestProfile[] = ['discovery', 'author', 'studio'];
const EXPECTED_ROLES = {
  discovery: 'viewer',
  author: 'editor',
  studio: 'owner',
} as const;

describe('Studio de démonstration local', () => {
  it('prépare un scénario versionné et les trois rôles sans appareil technique actif', async () => {
    const runtime = await createLocalRuntime();
    const seeded = await seedLocalDemoStudio(runtime);
    assert.equal(seeded.scenarioId, LOCAL_DEMO_SCENARIO_ID);

    const call = (path: string, profile: LocalTestProfile, body?: unknown) =>
      runtime.worker.fetch(
        new Request(`http://127.0.0.1:1420${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Authorization: `Bearer local-test:${profile}`,
            Origin: 'http://127.0.0.1:1420',
            'X-Scenario-Client-Version': '0.1.7',
            'X-Scenario-Device-Fingerprint': `manual-${profile}-device-000000001`,
            'X-Scenario-Platform': 'windows',
            ...(body === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Idempotency-Key': crypto.randomUUID(),
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );

    for (const profile of PROFILES) {
      const before = await runtime.repository.listDevices(
        `10000000-0000-4000-8000-00000000000${PROFILES.indexOf(profile) + 1}`,
      );
      assert.equal(
        before.some((device) => device.status === 'active'),
        false,
      );
      assert.equal(
        (
          await call('/v1/devices/activate', profile, {
            fingerprint: `manual-${profile}-device-000000001`,
            label: `Manuel ${profile}`,
            platform: 'windows',
          })
        ).status,
        201,
      );
      const response = await call('/v6/studios', profile);
      assert.equal(response.status, 200);
      const listing = (await response.json()) as {
        studios: Array<{
          id: string;
          scenarioId: string;
          name: string;
          role: string;
        }>;
      };
      assert.deepEqual(listing.studios, [
        {
          ...listing.studios[0],
          scenarioId: LOCAL_DEMO_SCENARIO_ID,
          name: LOCAL_DEMO_STUDIO_NAME,
          role: EXPECTED_ROLES[profile],
        },
      ]);
    }

    const detailResponse = await call(
      `/v6/studios/${seeded.studioId}`,
      'studio',
    );
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()) as {
      members: Array<{ role: string; status: string }>;
    };
    assert.deepEqual(detail.members.map((member) => member.role).sort(), [
      'editor',
      'owner',
      'viewer',
    ]);
    assert.ok(detail.members.every((member) => member.status === 'active'));

    const versionsResponse = await call(
      `/v5/scenarios/${LOCAL_DEMO_SCENARIO_ID}/versions`,
      'studio',
    );
    assert.equal(versionsResponse.status, 200);
    const versions = (await versionsResponse.json()) as {
      versions: Array<{
        parentVersionId: string | null;
        versionNumber: number;
      }>;
    };
    assert.equal(versions.versions.length, 1);
    assert.equal(versions.versions[0].parentVersionId, null);
    assert.equal(versions.versions[0].versionNumber, 1);
  });
});
