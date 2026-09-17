/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { SignedOfflineGrant } from '../../lib/commercial/contracts-v2.ts';
import {
  LocalTestRepository,
  LocalTestTokenVerifier,
} from '../src/localTestRepository.ts';
import { SupabaseJwksTokenVerifier } from '../src/jwt.ts';
import { createEphemeralOfflineGrantSigner } from '../src/offlineGrant.ts';
import { InMemoryRateLimiter } from '../src/rateLimit.ts';
import { createCommercialWorker } from '../src/worker.ts';
import { LocalBillingRepository } from '../src/localBillingRepository.ts';
import { LocalStripeGateway } from '../src/localStripeGateway.ts';
import { StripeWebhookVerifier } from '../src/stripeWebhook.ts';

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

describe('session Supabase', () => {
  it('valide signature JWKS, issuer, audience et expiration', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = (await crypto.subtle.exportKey(
      'jwk',
      pair.publicKey,
    )) as JsonWebKey & { kid?: string };
    publicJwk.kid = 'test-session-key';
    const header = encodeBase64Url(
      new TextEncoder().encode(
        JSON.stringify({ alg: 'ES256', kid: publicJwk.kid }),
      ),
    );
    const payload = encodeBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          sub: 'auth-user-id',
          aud: 'authenticated',
          iss: 'https://project.example.invalid/auth/v1',
          exp: 1_900_000_000,
        }),
      ),
    );
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    const token = `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
    const verifier = new SupabaseJwksTokenVerifier(
      'https://project.example.invalid',
      'authenticated',
      async () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }),
      () => 1_800_000_000_000,
    );
    await assert.doesNotReject(() => verifier.verify(`Bearer ${token}`));
    const tamperedSignature = new Uint8Array(signature);
    tamperedSignature[0] ^= 1;
    await assert.rejects(() =>
      verifier.verify(
        `Bearer ${header}.${payload}.${encodeBase64Url(tamperedSignature)}`,
      ),
    );
  });
});

describe('API commerciale v1', () => {
  let repository: LocalTestRepository;
  let worker: ReturnType<typeof createCommercialWorker>;

  beforeEach(async () => {
    repository = new LocalTestRepository();
    const billingRepository = new LocalBillingRepository(repository);
    worker = createCommercialWorker({
      environment: 'test',
      allowedOrigins: ['http://localhost:3000'],
      repository,
      tokenVerifier: new LocalTestTokenVerifier(),
      offlineGrantSigner: await createEphemeralOfflineGrantSigner(),
      rateLimiter: new InMemoryRateLimiter(100, 60_000),
      deviceFingerprintPepper: 'test-only-pepper',
      activationKeyPepper: 'local-test-activation-pepper',
      billingRepository,
      stripeGateway: new LocalStripeGateway(),
      stripeWebhookVerifier: new StripeWebhookVerifier('whsec_test'),
    });
  });

  function request(
    path: string,
    profile?: 'discovery' | 'author' | 'studio',
    init: RequestInit = {},
  ) {
    const headers = new Headers(init.headers);
    if (profile) headers.set('Authorization', `Bearer local-test:${profile}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    return worker.fetch(
      new Request(`https://api.example.invalid${path}`, { ...init, headers }),
    );
  }

  it('expose uniquement la configuration publique sans session', async () => {
    const response = await request('/v1/config');
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      version: string;
      offlineGrantPublicKey: JsonWebKey;
    };
    assert.equal(body.version, 'local-test-v1');
    assert.equal(body.offlineGrantPublicKey.crv, 'P-256');
    assert.equal((await request('/v1/me')).status, 401);
  });

  it('charge le rôle depuis le dépôt et non depuis le jeton', async () => {
    const response = await request('/v1/me', 'author');
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      role: string;
      account: { email: string };
    };
    assert.equal(body.role, 'customer');
    assert.equal(body.account.email, 'author@example.invalid');
  });

  it('signe un cache d’entitlements vérifiable et expirant', async () => {
    const configResponse = await request('/v1/config');
    const config = (await configResponse.json()) as {
      offlineGrantPublicKey: JsonWebKey;
    };
    const response = await request('/v1/entitlements', 'studio');
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      snapshot: { entitlements: Array<{ code: string; enabled: boolean }> };
      offlineGrant: SignedOfflineGrant;
    };
    const studioRights = new Set(
      body.snapshot.entitlements
        .filter(({ enabled }) => enabled)
        .map(({ code }) => code),
    );
    assert.equal(studioRights.has('pro_formats'), true);
    assert.equal(studioRights.has('scenario_versions'), true);
    assert.equal(studioRights.has('scene_cards'), true);
    const key = await crypto.subtle.importKey(
      'jwk',
      config.offlineGrantPublicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toArrayBuffer(decodeBase64Url(body.offlineGrant.signature)),
      new TextEncoder().encode(body.offlineGrant.payload),
    );
    assert.equal(verified, true);
    const payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(body.offlineGrant.payload)),
    ) as { expiresAt: string };
    assert.ok(Date.parse(payload.expiresAt) > Date.now());
  });

  it('applique la limite d’appareils côté serveur', async () => {
    const first = await request('/v1/devices/activate', 'discovery', {
      method: 'POST',
      body: JSON.stringify({
        fingerprint: 'first-device-fingerprint',
        label: 'Portable',
        platform: 'windows',
      }),
    });
    assert.equal(first.status, 201);
    const second = await request('/v1/devices/activate', 'discovery', {
      method: 'POST',
      body: JSON.stringify({
        fingerprint: 'second-device-fingerprint',
        label: 'Bureau',
        platform: 'windows',
      }),
    });
    assert.equal(second.status, 409);
    assert.equal(
      ((await second.json()) as { code: string }).code,
      'device_limit_reached',
    );
  });

  it('refuse qu’un client Auteur s’accorde Studio', async () => {
    const manipulated = await request('/v1/devices/activate', 'author', {
      method: 'POST',
      body: JSON.stringify({
        fingerprint: 'author-device-fingerprint',
        label: 'Portable',
        platform: 'macos',
        offer: 'studio',
      }),
    });
    assert.equal(manipulated.status, 400);
    assert.equal(
      ((await manipulated.json()) as { code: string }).code,
      'unexpected_field',
    );

    const entitlements = (await (
      await request('/v1/entitlements', 'author')
    ).json()) as { snapshot: { entitlements: Array<{ code: string }> } };
    assert.equal(
      entitlements.snapshot.entitlements.some(
        ({ code }) => code === 'cloud.sync',
      ),
      false,
    );
    for (const studioOnlyCode of [
      'pro_formats',
      'scenario_versions',
      'scene_cards',
    ]) {
      assert.equal(
        entitlements.snapshot.entitlements.some(
          ({ code }) => code === studioOnlyCode,
        ),
        false,
      );
    }
  });

  it('couvre appareils, usage et déconnexion', async () => {
    assert.equal((await request('/v1/devices', 'studio')).status, 200);
    assert.equal((await request('/v1/usage', 'studio')).status, 200);
    const logout = await request('/v1/auth/logout', 'studio', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(logout.status, 204);
    assert.ok(
      repository.audit.some(({ action }) => action === 'session.logout'),
    );
  });

  it('refuse les requêtes au-delà de la fenêtre de rate limit', async () => {
    const limitedWorker = createCommercialWorker({
      environment: 'test',
      allowedOrigins: [],
      repository,
      tokenVerifier: new LocalTestTokenVerifier(),
      offlineGrantSigner: await createEphemeralOfflineGrantSigner(),
      rateLimiter: new InMemoryRateLimiter(1, 60_000),
      deviceFingerprintPepper: 'test-only-pepper',
      activationKeyPepper: 'local-test-activation-pepper',
      billingRepository: new LocalBillingRepository(repository),
      stripeGateway: new LocalStripeGateway(),
      stripeWebhookVerifier: new StripeWebhookVerifier('whsec_test'),
    });
    const first = await limitedWorker.fetch(
      new Request('https://api.example.invalid/v1/me', {
        headers: { Authorization: 'Bearer local-test:studio' },
      }),
    );
    const second = await limitedWorker.fetch(
      new Request('https://api.example.invalid/v1/me', {
        headers: { Authorization: 'Bearer local-test:studio' },
      }),
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
  });
});
