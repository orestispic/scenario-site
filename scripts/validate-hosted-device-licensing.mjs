import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, webcrypto } from 'node:crypto';

import { parseEnvironmentFile } from './phase9-preflight.mjs';

const apiUrl = 'https://scenario-commercial-api-preproduction.ore-picard.workers.dev';
const origin = 'https://senario-app-preproduction.pages.dev';
const encoder = new TextEncoder();

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function decodeBase64Url(value) {
  return Uint8Array.from(Buffer.from(value, 'base64url'));
}

async function keyThumbprint(publicKey) {
  const canonical = JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y });
  return base64Url(new Uint8Array(await webcrypto.subtle.digest('SHA-256', encoder.encode(canonical))));
}

async function createKey() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pair, publicKey: await webcrypto.subtle.exportKey('jwk', pair.publicKey) };
}

async function signature(privateKey, message) {
  return base64Url(new Uint8Array(await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, encoder.encode(message),
  )));
}

async function login(supabaseUrl, anonKey, email, password) {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { Accept: 'application/json', apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Synthetic account login failed (${response.status}).`);
  const value = await response.json();
  if (typeof value.access_token !== 'string') throw new Error('Synthetic account returned no access token.');
  return value.access_token;
}

async function api(token, path, body, expected = [200]) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Accept: 'application/json', Authorization: `Bearer ${token}`, Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const value = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!expected.includes(response.status)) {
    const code = typeof value?.code === 'string' ? `:${value.code}` : '';
    throw new Error(`${path} returned ${response.status}${code}.`);
  }
  return { status: response.status, value };
}

async function signedApi(token, key, path, body, expected = [200]) {
  const method = body === undefined ? 'GET' : 'POST';
  const serialized = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const bodyDigest = base64Url(new Uint8Array(await webcrypto.subtle.digest('SHA-256', encoder.encode(serialized))));
  const proof = await signature(key.pair.privateKey, [
    'senario-request-proof-v1', method, path, timestamp, nonce, bodyDigest,
  ].join('\n'));
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json', Authorization: `Bearer ${token}`, Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Senario-Device-Key': await keyThumbprint(key.publicKey),
      'X-Senario-Device-Time': timestamp,
      'X-Senario-Device-Nonce': nonce,
      'X-Senario-Device-Body': bodyDigest,
      'X-Senario-Device-Signature': proof,
    },
    ...(body === undefined ? {} : { body: serialized }),
    signal: AbortSignal.timeout(20_000),
  });
  const value = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!expected.includes(response.status))
    throw new Error(`${path} returned ${response.status}:${String(value?.code ?? 'unknown')}.`);
  return { status: response.status, value };
}

async function activate(token, key, label) {
  const challenge = (await api(token, '/v2/devices/challenges', { purpose: 'activation' }, [201])).value.challenge;
  const body = {
    challengeId: challenge.id,
    signature: await signature(key.pair.privateKey, challenge.message),
    publicKey: key.publicKey,
    fingerprint: `hosted-license-e2e-${randomUUID()}`,
    label,
    platform: 'windows',
    clientVersion: '0.1.13',
  };
  const activated = await api(token, '/v2/devices/activate', body, [201]);
  return { body, device: activated.value.device };
}

async function run() {
  const environment = parseEnvironmentFile(readFileSync(resolve('.env.phase9.local'), 'utf8'));
  const accounts = parseEnvironmentFile(readFileSync(resolve('.env.phase9.accounts.local'), 'utf8'));
  const supabaseUrl = required(environment, 'SUPABASE_URL').replace(/\/$/, '');
  if (supabaseUrl !== 'https://zblnsdyaoljnezxdidtx.supabase.co') throw new Error('Refusing a non-preproduction Supabase project.');
  const anonKey = required(environment, 'SUPABASE_ANON_KEY');
  let selected;
  for (const role of ['OWNER', 'EDITOR', 'VIEWER']) {
    const token = await login(supabaseUrl, anonKey, required(accounts, `PHASE9_${role}_EMAIL`), required(accounts, `PHASE9_${role}_PASSWORD`));
    const devices = (await api(token, '/v1/devices', undefined)).value.devices;
    const activeCount = devices.filter(device => device.status === 'active').length;
    if (activeCount < 2) { selected = { role, token, activeCount }; break; }
  }
  if (!selected) throw new Error('All synthetic accounts already use both device slots.');

  const created = [];
  try {
    const available = 2 - selected.activeCount;
    let renewalKey;
    const createdDevices = [];
    for (let index = 0; index < available; index += 1) {
      const key = await createKey();
      const activation = await activate(selected.token, key, `Hosted licence E2E ${randomUUID().slice(0, 8)}`);
      created.push(activation.device.id);
      createdDevices.push({ key, activation });
      renewalKey ??= { key, activation };
      if (index === 0) {
        const replay = await api(selected.token, '/v2/devices/activate', activation.body, [409]);
        if (replay.value.code !== 'device_challenge_consumed') throw new Error('Activation challenge replay was not rejected.');
      }
    }

    const overflowKey = await createKey();
    const overflowChallenge = (await api(selected.token, '/v2/devices/challenges', { purpose: 'activation' }, [201])).value.challenge;
    const overflow = await api(selected.token, '/v2/devices/activate', {
      challengeId: overflowChallenge.id,
      signature: await signature(overflowKey.pair.privateKey, overflowChallenge.message),
      publicKey: overflowKey.publicKey,
      fingerprint: `hosted-license-overflow-${randomUUID()}`,
      label: 'Hosted licence overflow E2E', platform: 'windows', clientVersion: '0.1.13',
    }, [409]);
    if (overflow.value.code !== 'device_limit_reached') throw new Error('Third active device was not rejected by the hard limit.');

    if (createdDevices.length >= 1) {
      const first = createdDevices[0];
      const firstClaim = await signedApi(selected.token, first.key, '/v17/device-session/claim', {
        deviceId: first.activation.device.id, force: true,
      });
      if (createdDevices.length >= 2) {
        const second = createdDevices[1];
        const secondConflict = await signedApi(selected.token, second.key, '/v17/device-session/claim', {
          deviceId: second.activation.device.id, force: false,
        }, [409]);
        if (secondConflict.value.code !== 'device_session_in_use' ||
          secondConflict.value.conflict?.activeDevice?.id !== first.activation.device.id)
          throw new Error('The second device did not receive the active-device conflict.');
        const takeover = await signedApi(selected.token, second.key, '/v17/device-session/claim', {
          deviceId: second.activation.device.id, force: true,
        });
        const staleHeartbeat = await signedApi(selected.token, first.key, '/v17/device-session/heartbeat', {
          deviceId: first.activation.device.id, leaseId: firstClaim.value.session.leaseId,
        }, [409]);
        if (!['device_session_replaced', 'device_session_required'].includes(staleHeartbeat.value.code))
          throw new Error('The displaced device retained its online usage lease.');
        await signedApi(selected.token, second.key, '/v17/device-session/release', {
          deviceId: second.activation.device.id, leaseId: takeover.value.session.leaseId,
        }, [204]);
      } else {
        await signedApi(selected.token, first.key, '/v17/device-session/heartbeat', {
          deviceId: first.activation.device.id, leaseId: firstClaim.value.session.leaseId,
        });
        await signedApi(selected.token, first.key, '/v17/device-session/release', {
          deviceId: first.activation.device.id, leaseId: firstClaim.value.session.leaseId,
        }, [204]);
      }
    }

    const renewalChallenge = (await api(selected.token, '/v2/devices/challenges', {
      purpose: 'license_renewal', deviceId: renewalKey.activation.device.id,
    }, [201])).value.challenge;
    const license = (await api(selected.token, '/v2/licenses/renew', {
      challengeId: renewalChallenge.id,
      signature: await signature(renewalKey.key.pair.privateKey, renewalChallenge.message),
      deviceId: renewalKey.activation.device.id,
      clientVersion: '0.1.13',
    })).value;
    const payload = JSON.parse(Buffer.from(license.offlineGrant.payload, 'base64url').toString('utf8'));
    const expectedThumbprint = await keyThumbprint(renewalKey.key.publicKey);
    if (payload.licenseFormatVersion !== 2 || payload.deviceKeyThumbprint !== expectedThumbprint || payload.deviceId !== renewalKey.activation.device.id)
      throw new Error('Hosted offline license is not bound to the proved installation.');
    if (Date.parse(payload.expiresAt) > Date.parse(payload.entitlementValidUntil) || Date.parse(payload.expiresAt) > Date.now() + 30 * 86_400_000 + 60_000)
      throw new Error('Hosted offline license exceeds its allowed validity.');
    const config = (await api(selected.token, '/v1/config', undefined)).value;
    const verificationJwk = config.offlineGrantPublicKeys?.[license.offlineGrant.keyId];
    if (!verificationJwk) throw new Error('Offline license verification key is absent from public configuration.');
    const verificationKey = await webcrypto.subtle.importKey('jwk', verificationJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const verified = await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, verificationKey,
      decodeBase64Url(license.offlineGrant.signature), encoder.encode(license.offlineGrant.payload),
    );
    if (!verified) throw new Error('Hosted offline license signature is invalid.');

    await api(selected.token, '/v1/devices/deactivate', { deviceId: renewalKey.activation.device.id }, [204]);
    created.splice(created.indexOf(renewalKey.activation.device.id), 1);
    const revoked = await api(selected.token, '/v2/devices/challenges', {
      purpose: 'license_renewal', deviceId: renewalKey.activation.device.id,
    }, [403]);
    if (revoked.value.code !== 'device_revoked') throw new Error('Revoked device can still request a license challenge.');
    console.log(`PASS hosted device licensing (${selected.role.toLowerCase()}, active before=${selected.activeCount}, created=${available})`);
  } finally {
    for (const deviceId of created) {
      await api(selected.token, '/v1/devices/deactivate', { deviceId }, [204]).catch(() => undefined);
    }
    await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
      method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${selected.token}` },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined);
  }
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : 'Hosted device licensing validation failed.');
  process.exitCode = 1;
});
