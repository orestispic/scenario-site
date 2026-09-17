/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalRuntime } from '../src/localRuntime.ts';
import { deviceKeyThumbprint, deviceRequestMessage, sha256Base64Url } from '../src/deviceProof.ts';

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pair, publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}

async function sign(privateKey: CryptoKey, message: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(message),
  )));
}

test('cryptographic activation is atomic, renewal is device-bound and challenges are one-use', async () => {
  const runtime = await createLocalRuntime();
  const call = (path: string, body?: unknown) => runtime.worker.fetch(new Request(`http://localhost${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer local-test:studio', Origin: 'http://localhost:3000', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));

  const keys = await Promise.all([keyPair(), keyPair(), keyPair()]);
  const challenges = await Promise.all(keys.map(async () => {
    const response = await call('/v2/devices/challenges', { purpose: 'activation' });
    assert.equal(response.status, 201);
    return (await response.json() as { challenge: { id: string; message: string } }).challenge;
  }));
  const activations = await Promise.all(keys.map(async ({ pair, publicKey }, index) => call('/v2/devices/activate', {
    challengeId: challenges[index]!.id,
    signature: await sign(pair.privateKey, challenges[index]!.message),
    publicKey,
    fingerprint: `cryptographic-device-${index}-fixture`,
    label: `Appareil ${index + 1}`,
    platform: 'windows',
    clientVersion: '0.1.12',
  })));
  assert.equal(activations.filter(response => response.status === 201).length, 2);
  assert.equal(activations.filter(response => response.status === 409).length, 1);

  const activatedIndex = activations.findIndex(response => response.status === 201);
  const activated = await activations[activatedIndex]!.json() as { device: { id: string } };
  const renewalChallengeResponse = await call('/v2/devices/challenges', { purpose: 'license_renewal', deviceId: activated.device.id });
  const renewalChallenge = (await renewalChallengeResponse.json() as { challenge: { id: string; message: string } }).challenge;

  const wrongKey = keys.find((_, index) => index !== activatedIndex)!;
  const invalidRenewal = await call('/v2/licenses/renew', {
    deviceId: activated.device.id,
    challengeId: renewalChallenge.id,
    signature: await sign(wrongKey.pair.privateKey, renewalChallenge.message),
    clientVersion: '0.1.12',
  });
  assert.equal(invalidRenewal.status, 403);

  const replay = await call('/v2/licenses/renew', {
    deviceId: activated.device.id,
    challengeId: renewalChallenge.id,
    signature: await sign(keys[activatedIndex]!.pair.privateKey, renewalChallenge.message),
    clientVersion: '0.1.12',
  });
  assert.equal(replay.status, 409, 'an invalid proof burns the challenge and prevents replay');

  const freshChallengeResponse = await call('/v2/devices/challenges', { purpose: 'license_renewal', deviceId: activated.device.id });
  const freshChallenge = (await freshChallengeResponse.json() as { challenge: { id: string; message: string } }).challenge;
  const renewal = await call('/v2/licenses/renew', {
    deviceId: activated.device.id,
    challengeId: freshChallenge.id,
    signature: await sign(keys[activatedIndex]!.pair.privateKey, freshChallenge.message),
    clientVersion: '0.1.12',
  });
  assert.equal(renewal.status, 200);
  const license = await renewal.json() as { snapshot: { offlineValidUntil: string }; offlineGrant: { payload: string } };
  const payload = JSON.parse(Buffer.from(license.offlineGrant.payload, 'base64url').toString()) as {
    deviceId: string; deviceKeyThumbprint: string; licenseId: string; licenseFormatVersion: number;
  };
  assert.equal(payload.deviceId, activated.device.id);
  assert.equal(payload.deviceKeyThumbprint, await deviceKeyThumbprint(keys[activatedIndex]!.publicKey));
  assert.match(payload.licenseId, /^[0-9a-f-]{36}$/i);
  assert.equal(payload.licenseFormatVersion, 2);

  assert.equal((await call('/v1/devices/deactivate', { deviceId: activated.device.id })).status, 204);
  assert.equal((await call('/v2/devices/challenges', { purpose: 'license_renewal', deviceId: activated.device.id })).status, 403);
});

test('activation rejects a public key that does not own the challenge signature', async () => {
  const runtime = await createLocalRuntime();
  const call = (path: string, body: unknown) => runtime.worker.fetch(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { Authorization: 'Bearer local-test:author', Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  const [declared, signer] = await Promise.all([keyPair(), keyPair()]);
  const challenge = (await (await call('/v2/devices/challenges', { purpose: 'activation' })).json() as { challenge: { id: string; message: string } }).challenge;
  const response = await call('/v2/devices/activate', {
    challengeId: challenge.id, signature: await sign(signer.pair.privateKey, challenge.message), publicKey: declared.publicKey,
    fingerprint: 'mismatched-proof-fixture', label: 'Faux appareil', platform: 'windows', clientVersion: '0.1.12',
  });
  assert.equal(response.status, 403);
  assert.equal((await runtime.repository.listDevices('10000000-0000-4000-8000-000000000002')).length, 0);
});

test('copying a legacy fingerprint cannot replace an already bound device key', async () => {
  const runtime = await createLocalRuntime();
  const call = (path: string, body: unknown) => runtime.worker.fetch(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { Authorization: 'Bearer local-test:author', Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  const fingerprint = 'copied-fingerprint-fixture';
  const activate = async (key: Awaited<ReturnType<typeof keyPair>>) => {
    const challenge = (await (await call('/v2/devices/challenges', { purpose: 'activation' })).json() as { challenge: { id: string; message: string } }).challenge;
    return call('/v2/devices/activate', {
      challengeId: challenge.id, signature: await sign(key.pair.privateKey, challenge.message), publicKey: key.publicKey,
      fingerprint, label: 'Même empreinte copiée', platform: 'windows', clientVersion: '0.1.12',
    });
  };
  assert.equal((await activate(await keyPair())).status, 201);
  const replacement = await activate(await keyPair());
  assert.equal(replacement.status, 409);
  assert.equal((await replacement.json() as { code: string }).code, 'device_identity_conflict');
});

test('hosted cloud calls require a fresh request signature from the active device key', async () => {
  const runtime = await createLocalRuntime({ environment: 'staging' });
  const key = await keyPair();
  const baseHeaders = { Authorization: 'Bearer local-test:studio', Origin: 'http://localhost:3000', 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) => runtime.worker.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: baseHeaders, body: JSON.stringify(body) }));
  const challenge = (await (await post('/v2/devices/challenges', { purpose: 'activation' })).json() as { challenge: { id: string; message: string } }).challenge;
  const fingerprint = 'hosted-request-proof-fixture';
  assert.equal((await post('/v2/devices/activate', {
    challengeId: challenge.id, signature: await sign(key.pair.privateKey, challenge.message), publicKey: key.publicKey,
    fingerprint, label: 'Appareil signé', platform: 'windows', clientVersion: '0.1.12',
  })).status, 201);

  const unproved = await runtime.worker.fetch(new Request('http://localhost/v5/scenarios', {
    headers: { Authorization: baseHeaders.Authorization, Origin: baseHeaders.Origin, 'X-Scenario-Device-Fingerprint': fingerprint, 'X-Scenario-Platform': 'windows', 'X-Scenario-Client-Version': '0.1.12' },
  }));
  assert.equal(unproved.status, 403);

  const path = '/v5/scenarios';
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const bodyDigest = await sha256Base64Url('');
  const signature = await sign(key.pair.privateKey, deviceRequestMessage({ method: 'GET', path, timestamp, nonce, bodyDigest }));
  const proved = await runtime.worker.fetch(new Request(`http://localhost${path}`, { headers: {
    Authorization: baseHeaders.Authorization, Origin: baseHeaders.Origin,
    'X-Scenario-Device-Fingerprint': fingerprint, 'X-Scenario-Platform': 'windows', 'X-Scenario-Client-Version': '0.1.12',
    'X-Senario-Device-Key': await deviceKeyThumbprint(key.publicKey), 'X-Senario-Device-Time': timestamp,
    'X-Senario-Device-Nonce': nonce, 'X-Senario-Device-Body': bodyDigest, 'X-Senario-Device-Signature': signature,
  } }));
  assert.equal(proved.status, 200);
});

test('a verified refund revokes paid entitlements without touching account data', async () => {
  const runtime = await createLocalRuntime();
  runtime.repository.registerLocalUser('refund-user', 'refund@example.invalid', 'Refund Test');
  const profile = await runtime.repository.getProfile('refund-user');
  assert(profile);
  runtime.repository.grantEntitlements(profile.id, {
    configurationVersion: 'paid-before-refund', issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    offlineValidUntil: new Date(Date.now() + 86_400_000).toISOString(), deviceLimit: 2,
    entitlements: [{ code: 'cloud_sync', enabled: true, value: null }],
  });
  assert((await runtime.repository.getEntitlements(profile.id))!.snapshot.entitlements.some(item => item.code === 'cloud_sync'));
  const event = {
    id: 'evt_refund_fixture', type: 'charge.refunded' as const, created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: { customer: 'cus_refund_fixture', metadata: { scenario_profile_id: profile.id } } },
  };
  assert.deepEqual(await runtime.billing.applyStripeEvent(event, JSON.stringify(event)), { replayed: false });
  assert.equal((await runtime.repository.getEntitlements(profile.id))!.snapshot.entitlements.some(item => item.code === 'cloud_sync'), false);
  assert.deepEqual(await runtime.billing.applyStripeEvent(event, JSON.stringify(event)), { replayed: true });
  assert.equal((await runtime.repository.getProfile('refund-user'))!.account.displayName, 'Refund Test');
});
