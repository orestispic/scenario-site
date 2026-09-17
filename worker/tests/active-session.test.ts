import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createActiveSessionCheck } from '../src/activeSession.ts';
import { AuthenticationError, SupabaseJwksTokenVerifier } from '../src/jwt.ts';
import type { WorkerEnvironment } from '../src/types.ts';

void test('session check fails closed on logout, suspension, malformed results and service outage', async () => {
  const environment = { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_fixture' } as WorkerEnvironment;
  const profile = randomUUID(), session = randomUUID();
  const check = (result: unknown, status = 200) => createActiveSessionCheck(environment, async (url, init) => {
    assert.equal(url, 'https://fixture.supabase.co/rest/v1/rpc/is_account_session_active_v16');
    assert.deepEqual(JSON.parse(String(init?.body)), { p_auth_user_id: profile, p_session_id: session });
    return Response.json(result, { status });
  })(profile, session);
  await check(true);
  await assert.rejects(check(false), AuthenticationError);
  await assert.rejects(check({ active: true }), AuthenticationError);
  await assert.rejects(check('internal secret', 503), { status: 503, code: 'authentication_unavailable' });
});

void test('JWT verifier checks signed session binding every time, and rejects missing session or malformed expiry', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'fixture' };
  const user = randomUUID(), session = randomUUID();
  let checks = 0, active = true;
  const verifier = new SupabaseJwksTokenVerifier('https://fixture.supabase.co', 'authenticated',
    async () => Response.json({ keys: [jwk] }), Date.now, async (uid, sid) => {
      checks++; assert.equal(uid, user); assert.equal(sid, session);
      if (!active) throw new AuthenticationError();
    });
  const signed = async (extra: Record<string, unknown> = {}) => {
    const header = Buffer.from(JSON.stringify({ kid: 'fixture', alg: 'ES256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: user, session_id: session, aud: 'authenticated', iss: 'https://fixture.supabase.co/auth/v1', exp: Math.floor(Date.now()/1000)+600, ...extra })).toString('base64url');
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    return `Bearer ${header}.${payload}.${Buffer.from(signature).toString('base64url')}`;
  };
  const token = await signed();
  await verifier.verify(token);
  active = false;
  await assert.rejects(verifier.verify(token), AuthenticationError);
  assert.equal(checks, 2);
  await assert.rejects(verifier.verify(await signed({ session_id: undefined })), AuthenticationError);
  await assert.rejects(verifier.verify(await signed({ exp: '9999999999' })), AuthenticationError);
  assert.equal(checks, 2);
});
