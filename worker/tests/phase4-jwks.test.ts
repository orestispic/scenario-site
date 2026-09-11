/* oxlint-disable typescript/no-floating-promises */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseJwksTokenVerifier } from '../src/jwt.ts';

test('JWKS rotation, single fetch for parallel verification, outage and recovery', async () => {
  let now = Date.now();
  async function signed(kid: string) {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const key = {
      ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
      kid,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'fixture',
        aud: 'authenticated',
        iss: 'https://fixture.invalid/auth/v1',
        exp: Math.floor(now / 1000) + 3600,
      }),
    ).toString('base64url');
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return {
      key,
      token: `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`,
    };
  }
  const first = await signed('first'),
    second = await signed('second');
  let calls = 0,
    outage = false;
  let keys = [first.key];
  const verifier = new SupabaseJwksTokenVerifier(
    'https://fixture.invalid',
    'authenticated',
    async () => {
      calls += 1;
      return Response.json({ keys }, { status: outage ? 503 : 200 });
    },
    () => now,
  );
  await Promise.all(
    Array.from({ length: 10 }, () => verifier.verify(`Bearer ${first.token}`)),
  );
  assert.equal(calls, 1);
  now += 11_000;
  keys = [second.key];
  await verifier.verify(`Bearer ${second.token}`);
  assert.equal(calls, 2);
  now += 301_000;
  outage = true;
  await assert.rejects(verifier.verify(`Bearer ${second.token}`), {
    status: 503,
  });
  outage = false;
  await verifier.verify(`Bearer ${second.token}`);
});
