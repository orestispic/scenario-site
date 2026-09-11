import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, Log, LogLevel } from 'miniflare';

const runtime = new Miniflare({
  modules: true,
  script: await readFile('.wrangler/phase4-local/local-test.js', 'utf8'),
  compatibilityDate: '2026-05-22',
  compatibilityFlags: ['nodejs_compat'],
  log: new Log(LogLevel.ERROR),
});
try {
  let token = '';
  const call = (path, body, extraHeaders = {}) =>
    runtime.dispatchFetch(`http://localhost${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const signup = await call('/_local/auth/v1/signup', {
    email: 'runtime@example.invalid',
    password: 'local-test-only-password',
  });
  assert.equal(signup.status, 200);
  const initial = await (
    await call('/_local/auth/v1/token?grant_type=password', {
      email: 'runtime@example.invalid',
      password: 'local-test-only-password',
    })
  ).json();
  token = initial.access_token;
  const me = await (await call('/v1/me')).json();
  assert.equal(me.role, 'customer');
  const billing = await (await call('/v2/billing')).json();
  const offer = billing.offers[0];
  const checkout = await call('/v2/checkout/sessions', {
    selectionId: offer.selectionId,
    successUrl: 'http://localhost:3000/success',
    cancelUrl: 'http://localhost:3000/cancel',
  });
  assert.equal(checkout.status, 201);
  const timestamp = Math.floor(Date.now() / 1000);
  const event = {
    id: 'evt_workerd_local',
    type: 'customer.subscription.created',
    created: timestamp,
    livemode: false,
    data: {
      object: {
        id: 'sub_workerd',
        customer: 'cus_workerd',
        metadata: { scenario_profile_id: me.account.id },
        status: 'active',
        current_period_start: timestamp,
        current_period_end: timestamp + 86400,
        items: { data: [{ price: { id: 'price_test_author_month' } }] },
      },
    },
  };
  const signature = createHmac('sha256', 'whsec_local_fixture_only')
    .update(`${timestamp}.${JSON.stringify(event)}`)
    .digest('hex');
  const webhook = () =>
    call('/v2/stripe/webhook', event, {
      'Stripe-Signature': `t=${timestamp},v1=${signature}`,
    });
  assert.equal((await (await webhook()).json()).replayed, false);
  assert.equal((await (await webhook()).json()).replayed, true);
  const entitlements = await (await call('/v3/entitlements')).json();
  assert.equal(entitlements.contractVersion, '2026-09-v4');
  const config = await (await call('/v1/config')).json();
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    config.offlineGrantPublicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  assert.equal(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      Buffer.from(entitlements.offlineGrant.signature, 'base64url'),
      new TextEncoder().encode(entitlements.offlineGrant.payload),
    ),
    true,
  );
  const createdKey = await (
    await call(
      '/_local/admin/activation-keys',
      {
        selectionId: offer.selectionId,
        maximumActivations: 1,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      { 'x-scenario-local-admin': 'phase3-local-only' },
    )
  ).json();
  const redeemed = await call('/v2/activation-keys/redeem', {
    key: createdKey.key,
    fingerprint: 'workerd-device-fingerprint',
    label: 'Fixture device',
    platform: 'windows',
  });
  assert.equal(redeemed.status, 201);
  const deviceId = (await redeemed.json()).activation.deviceId;
  assert.equal(
    (await call('/v1/devices/deactivate', { deviceId })).status,
    204,
  );
  assert.equal(
    (
      await runtime.dispatchFetch(
        `http://localhost/_local/admin/activation-keys/${createdKey.id}`,
        {
          method: 'DELETE',
          headers: { 'x-scenario-local-admin': 'phase3-local-only' },
        },
      )
    ).status,
    204,
  );
  const rotated = await (
    await call('/_local/auth/v1/token?grant_type=refresh_token', {
      refresh_token: initial.refresh_token,
    })
  ).json();
  token = rotated.access_token;
  assert.equal((await call('/v1/auth/logout', {})).status, 204);
  assert.equal((await call('/v1/me')).status, 401);
  assert.equal(
    (
      await call('/_local/auth/v1/token?grant_type=refresh_token', {
        refresh_token: rotated.refresh_token,
      })
    ).status,
    401,
  );
  console.log(
    'workerd local E2E passed: registration/login, Checkout, verified webhook/replay, signed rights, device/key activation and revocation, refresh/logout.',
  );
} finally {
  await runtime.dispose();
}
