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
