/* oxlint-disable typescript/no-floating-promises */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAccount, takeEmailLink } from '../lib/commercial/browser-account.ts';
const requestUrl = (url: string | URL | Request) => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
test('confirmation fragment is removed before any exchange and is distinct from recovery', () => {
  let replaced = ''; const hash = 'a'.repeat(64);
  assert.deepEqual(takeEmailLink(new URL(`https://site.invalid/#token_hash=${hash}&type=signup`), (url) => { replaced = url; }), { type: 'signup', tokenHash: hash });
  assert.equal(replaced, '/connexion');
  assert.equal(takeEmailLink(new URL(`https://site.invalid/#token_hash=${hash}&type=invite`), () => {}), null);
});
test('standard Supabase email session is kept only in memory for the intended route', () => {
  let replaced = '';
  const link = takeEmailLink(
    new URL('https://site.invalid/#access_token=access-token-fixture&refresh_token=refresh-token-fixture&type=recovery&expires_in=300'),
    (url) => { replaced = url; },
  );
  assert.deepEqual(link, {
    type: 'recovery',
    session: { accessToken: 'access-token-fixture', refreshToken: 'refresh-token-fixture', expiresIn: 300 },
  });
  assert.equal(replaced, '/reinitialisation');
});
test('expired email links are stripped and become an explicit safe error state', () => {
  let replaced = '';
  const action = takeEmailLink(
    new URL('https://site.invalid/reinitialisation?error=access_denied&error_code=otp_expired&error_description=secret-provider-detail'),
    (url) => { replaced = url; },
  );
  assert.deepEqual(action, {
    type: 'error',
    target: 'recovery',
    message: 'Ce lien de réinitialisation est invalide ou a expiré. Demandez un nouveau lien et utilisez uniquement le plus récent.',
  });
  assert.equal(replaced, '/reinitialisation');
});
test('signup and recovery destinations are sent as encoded Auth query parameters', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = new BrowserAccount({ apiBaseUrl: 'https://api.invalid', supabaseUrl: 'https://auth.invalid', supabaseKey: 'sb_publishable_fixture' }, (async (url, init) => {
    calls.push({ url: requestUrl(url), body: JSON.parse(init!.body as string) });
    return Response.json({});
  }) as typeof fetch);
  await client.signUp('fixture@example.invalid', 'synthetic', 'Fixture', 'https://site.invalid/connexion');
  await client.recover('fixture@example.invalid', 'https://site.invalid/reinitialisation');
  assert.equal(calls[0].url, 'https://auth.invalid/auth/v1/signup?redirect_to=https%3A%2F%2Fsite.invalid%2Fconnexion');
  assert.deepEqual(calls[0].body, { email: 'fixture@example.invalid', password: 'synthetic', data: { display_name: 'Fixture' } });
  assert.equal(calls[1].url, 'https://auth.invalid/auth/v1/recover?redirect_to=https%3A%2F%2Fsite.invalid%2Freinitialisation');
  assert.deepEqual(calls[1].body, { email: 'fixture@example.invalid' });
});
test('confirmation verifies signup once and closes its temporary session', async () => {
  const calls: string[] = [];
  const client = new BrowserAccount({ apiBaseUrl: 'https://api.invalid', supabaseUrl: 'https://auth.invalid', supabaseKey: 'sb_publishable_fixture' }, (async (url, init) => {
    calls.push(requestUrl(url));
    if (requestUrl(url).endsWith('/verify')) {
      assert.equal(JSON.parse(init!.body as string).type, 'signup');
      return Response.json({ access_token: 'fixture', refresh_token: 'fixture-refresh', expires_in: 300 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  await client.confirmEmail({ type: 'signup', tokenHash: 'a'.repeat(64) });
  assert.equal(calls.length, 2); assert.ok(calls[1].endsWith('/v1/auth/logout'));
  await assert.rejects(client.token());
  await assert.rejects(client.confirmEmail({ type: 'signup', tokenHash: 'invalid' })); assert.equal(calls.length, 2);
});
test('expired confirmation is refused without creating a session', async () => {
  const client = new BrowserAccount({ apiBaseUrl: 'https://api.invalid', supabaseUrl: 'https://auth.invalid', supabaseKey: 'sb_publishable_fixture' }, (async () => new Response(null, { status: 403 })) as typeof fetch);
  await assert.rejects(client.confirmEmail({ type: 'signup', tokenHash: 'a'.repeat(64) })); await assert.rejects(client.token());
});
test('late failed confirmation cannot clear a newer login', async () => {
  let finish!: (value: Response) => void;
  const client = new BrowserAccount({ apiBaseUrl: 'https://api.invalid', supabaseUrl: 'https://auth.invalid', supabaseKey: 'sb_publishable_fixture' }, (async (url) => {
    if (requestUrl(url).endsWith('/verify')) return new Promise<Response>((resolve) => { finish = resolve; });
    return Response.json({ access_token: 'new-login', refresh_token: 'fixture-refresh', expires_in: 300 });
  }) as typeof fetch);
  const confirmation = client.confirmEmail({ type: 'signup', tokenHash: 'a'.repeat(64) });
  await client.signIn('fixture@example.invalid', 'fixture');
  finish(new Response(null, { status: 403 }));
  await assert.rejects(confirmation); assert.equal(await client.token(), 'new-login'); client.clear();
});
