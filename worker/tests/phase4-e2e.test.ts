/* oxlint-disable typescript/no-floating-promises */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/localRuntime.ts';
import { signStripeFixture } from '../src/stripeWebhook.ts';
import type { RequestMetric } from '../src/observability.ts';
import { CommercialRepositoryError } from '../src/types.ts';

test('local journey: registration, login, Checkout, signed webhook, rights, device/key revocation, refresh and logout', async () => {
  let now = Date.now();
  const metrics: RequestMetric[] = [];
  const runtime = await createLocalRuntime(
    { telemetry: { record: (metric) => metrics.push(metric) } },
    () => now,
  );
  const auth = (path: string, body: unknown) =>
    runtime.auth.fetch(
      new Request(`http://localhost/_local/auth/v1${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  assert.equal(
    (
      await auth('/signup', {
        email: 'journey@example.invalid',
        password: 'local-password-fixture',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await auth('/token?grant_type=password', {
        email: 'journey@example.invalid',
        password: 'wrong',
      })
    ).status,
    401,
  );
  const session = (await (
    await auth('/token?grant_type=password', {
      email: 'journey@example.invalid',
      password: 'local-password-fixture',
    })
  ).json()) as { access_token: string; refresh_token: string };
  let token = session.access_token;
  const call = (path: string, body?: unknown) =>
    runtime.worker.fetch(
      new Request(`http://localhost${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Origin: 'http://localhost:3000',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const me = (await (await call('/v1/me')).json()) as {
    account: { id: string };
    role: string;
  };
  assert.equal(me.role, 'customer');
  const offers = await runtime.billing.listOffers();
  const selection = await runtime.billing.getSelection(offers[0].selectionId);
  const before = (await (await call('/v3/entitlements')).json()) as {
    snapshot: { id: string };
  };
  assert.equal(
    (
      await call('/v2/checkout/sessions', {
        selectionId: offers[0].selectionId,
        successUrl: 'http://localhost:3000/success',
        cancelUrl: 'http://localhost:3000/cancel',
      })
    ).status,
    201,
  );
  assert.equal(
    (await runtime.repository.getEntitlements(me.account.id))!.snapshot.id,
    before.snapshot.id,
  );
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({
    id: 'evt_phase4_journey',
    type: 'customer.subscription.created',
    created: timestamp,
    livemode: false,
    data: {
      object: {
        id: 'sub_fixture',
        customer: 'cus_fixture',
        metadata: { scenario_profile_id: me.account.id },
        status: 'active',
        current_period_start: timestamp,
        current_period_end: timestamp + 86400,
        items: { data: [{ price: { id: selection!.providerPriceReference } }] },
      },
    },
  });
  const signature = await signStripeFixture(
    'whsec_local_fixture_only',
    rawBody,
    timestamp,
  );
  const webhook = () =>
    runtime.worker.fetch(
      new Request('http://localhost/v2/stripe/webhook', {
        method: 'POST',
        headers: { 'Stripe-Signature': signature },
        body: rawBody,
      }),
    );
  const deliveries = await Promise.all(
    Array.from({ length: 10 }, () => webhook()),
  );
  const results = await Promise.all(
    deliveries.map(
      (response) => response.json() as Promise<{ replayed: boolean }>,
    ),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  const grant = (await (await call('/v3/entitlements')).json()) as {
    snapshot: unknown;
    offlineGrant: { payload: string; signature: string };
    contractVersion: string;
  };
  assert.equal(grant.contractVersion, '2026-09-v4');
  const config = (await (await call('/v1/config')).json()) as {
    offlineGrantPublicKey: JsonWebKey;
  };
  const key = await crypto.subtle.importKey(
    'jwk',
    config.offlineGrantPublicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  assert.equal(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Buffer.from(grant.offlineGrant.signature, 'base64url'),
      new TextEncoder().encode(grant.offlineGrant.payload),
    ),
    true,
  );
  const payload = JSON.parse(
    Buffer.from(grant.offlineGrant.payload, 'base64url').toString(),
  );
  assert.deepEqual(JSON.parse(payload.snapshotJson), grant.snapshot);
  const device = {
    fingerprint: 'phase4-fingerprint-123456',
    label: 'Local device',
    platform: 'windows',
  };
  const activation = (await (
    await call('/v1/devices/activate', device)
  ).json()) as { device: { id: string } };
  const readDeviceLease = async () => {
    const response = await runtime.worker.fetch(new Request('http://localhost/v3/entitlements?offline=1', {
      headers: { Authorization: `Bearer ${token}`, Origin: 'http://localhost:3000', 'X-Scenario-Device-Fingerprint': device.fingerprint },
    }));
    assert.equal(response.status, 200);
    const result = await response.json() as { offlineGrant: { payload: string } };
    return JSON.parse(Buffer.from(result.offlineGrant.payload, 'base64url').toString()) as { deviceId: string | null; deviceFingerprint: string | null; serverTime: string };
  };
  const deviceLease = await readDeviceLease();
  assert.equal(deviceLease.deviceId, activation.device.id);
  assert.equal(deviceLease.deviceFingerprint, device.fingerprint);
  assert(Number.isFinite(Date.parse(deviceLease.serverTime)));
  assert.equal(
    (await call('/v1/devices/deactivate', { deviceId: activation.device.id }))
      .status,
    204,
  );
  assert.equal((await readDeviceLease()).deviceId, null, 'revoked device cannot renew an offline lease');
  const createdKey = await runtime.billing.createLocalActivationKey({
    selectionId: offers[0].selectionId,
    maximumActivations: 1,
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  });
  const redemptions = await Promise.all(
    Array.from({ length: 5 }, () =>
      call('/v2/activation-keys/redeem', { ...device, key: createdKey.key }),
    ),
  );
  assert.equal(
    redemptions.filter((response) => response.status === 201).length,
    1,
  );
  assert.equal(
    (await call('/v2/activation-keys/revoke', { keyId: createdKey.id })).status,
    403,
  );
  await runtime.billing.revokeActivationKey({
    keyId: createdKey.id,
    actorProfileId: 'local-admin',
  });
  const status = await runtime.billing.listActivations(me.account.id);
  assert.equal(status[0].status, 'revoked');
  assert.notEqual(
    (await runtime.repository.getEntitlements(me.account.id))!.snapshot
      .configurationVersion,
    'local-billing-v1',
  );
  assert.equal(
    (await call('/v1/devices/activate', { ...device, role: 'admin' })).status,
    400,
  );
  now += 61_000;
  assert.equal((await call('/v1/me')).status, 401);
  const rotated = (await (
    await auth('/token?grant_type=refresh_token', {
      refresh_token: session.refresh_token,
    })
  ).json()) as { access_token: string; refresh_token: string };
  assert.notEqual(rotated.refresh_token, session.refresh_token);
  assert.equal(
    (
      await auth('/token?grant_type=refresh_token', {
        refresh_token: session.refresh_token,
      })
    ).status,
    401,
  );
  token = rotated.access_token;
  assert.equal((await call('/v1/me')).status, 200);
  assert.equal((await call('/v1/auth/logout', {})).status, 204);
  assert.equal((await call('/v1/me')).status, 401);
  assert.equal(
    (
      await auth('/token?grant_type=refresh_token', {
        refresh_token: rotated.refresh_token,
      })
    ).status,
    401,
  );
  const serialized = JSON.stringify(metrics);
  for (const sensitive of [
    session.access_token,
    session.refresh_token,
    me.account.id,
    createdKey.key,
    'journey@example.invalid',
  ])
    assert.ok(!serialized.includes(sensitive));
  assert.ok(metrics.some((metric) => metric.webhook === 'replayed'));
});

test('CORS/CSRF, preflight correlation, bounded bodies, limiter failure recovery, log sanitization', async () => {
  let outage = true;
  const metrics: RequestMetric[] = [];
  const runtime = await createLocalRuntime({
    telemetry: { record: (metric) => metrics.push(metric) },
    rateLimiter: {
      allow: async () => {
        if (outage)
          throw new CommercialRepositoryError(
            503,
            'rate_limiter_unavailable',
            'Unavailable',
          );
        return true;
      },
    },
  });
  const call = (path: string, init?: RequestInit) =>
    runtime.worker.fetch(new Request(`http://localhost${path}`, init));
  assert.equal((await call('/v1/me')).status, 503);
  outage = false;
  const preflight = await call('/v1/me', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:3000' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(metrics.at(-1)?.status, 204);
  assert.equal(
    metrics.at(-1)?.request_id,
    preflight.headers.get('x-request-id'),
  );
  const rejected = await call('/v1/auth/logout', {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.invalid',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(
    (
      await call('/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await call('/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'session=fake' },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.equal((await call('/v1/config')).status, 200);
  const tooLarge = await call('/v1/devices/activate', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer local-test:discovery',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ padding: 'x'.repeat(9000) }),
  });
  assert.equal(tooLarge.status, 413);
  await call('/do-not-log-this-secret?token=another-secret');
  assert.equal(metrics.at(-1)?.route, 'unknown');
  assert.ok(!JSON.stringify(metrics).includes('secret'));
});
