/* oxlint-disable typescript/no-floating-promises */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAccount, validateBrowserConfig, takeRecoveryHash, safeStripeUrl } from '../lib/commercial/browser-account.ts';
import { readPublicBetaCatalog } from '../lib/commercial/contracts-v11.ts';

const config = { apiBaseUrl: 'https://api.example.invalid', supabaseUrl: 'https://auth.example.invalid', supabaseKey: 'sb_publishable_fixture' };
const requestUrl = (input: string | URL | Request) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const session = (access = 'fixture-access', expires = 3600) => Response.json({ access_token: access, refresh_token: 'fixture-refresh', expires_in: expires });
test('browser configuration rejects insecure endpoints and private keys', () => {
  assert.equal(validateBrowserConfig(config), true);
  for (const value of ['http://api.example.invalid', 'https://a:b@api.example.invalid', 'https://api.example.invalid/?token=secret'])
    assert.equal(validateBrowserConfig({ ...config, apiBaseUrl: value }), false);
  assert.equal(validateBrowserConfig({ ...config, supabaseKey: 'sb_secret_fixture' }), false);
});
test('recovery fragment is consumed once without preserving tokens or external redirect', () => {
  let replaced = '';
  const hash = 'a'.repeat(64);
  assert.equal(takeRecoveryHash(new URL(`https://site.example.invalid/#token_hash=${hash}&type=recovery&next=https://evil.invalid`), (url) => replaced = url), hash);
  assert.equal(replaced, '/reinitialisation');
  assert.equal(takeRecoveryHash(new URL(`https://site.example.invalid/${replaced}`), () => assert.fail()), null);
  assert.equal(takeRecoveryHash(new URL('https://site.example.invalid/#access_token=secret&refresh_token=secret'), (url) => replaced = url), null);
  assert.equal(replaced, '/connexion');
});
test('billing navigation rejects unsafe Stripe origins', () => {
  assert.equal(safeStripeUrl('https://checkout.stripe.com/c/pay/cs_test_fixture', 'checkout', true), 'https://checkout.stripe.com/c/pay/cs_test_fixture');
  for (const value of ['javascript:alert(1)', 'https://checkout.stripe.com.evil.invalid/', 'https://user@checkout.stripe.com/'])
    assert.throws(() => safeStripeUrl(value, 'checkout', true));
  assert.equal(safeStripeUrl('https://checkout.stripe.com/c/pay/cs_live_fixture', 'checkout', false), 'https://checkout.stripe.com/c/pay/cs_live_fixture');
});
test('20 simultaneous token requests rotate the refresh token only once', async () => {
  let time = 0; let refreshes = 0;
  const client = new BrowserAccount(config, (async (url) => {
    if (requestUrl(url).includes('refresh_token')) { refreshes++; return session('rotated'); }
    return session();
  }) as typeof fetch, () => time);
  await client.signIn('fixture@example.invalid', 'synthetic'); time = 3_550_000;
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => client.token())), Array(20).fill('rotated'));
  assert.equal(refreshes, 1); client.clear();
  await assert.rejects(client.token(), /Connectez-vous/);
});
test('late login response cannot restore a closed session', async () => {
  let finish!: (response: Response) => void;
  const client = new BrowserAccount(config, (() => new Promise((resolve) => { finish = resolve; })) as typeof fetch);
  const login = client.signIn('fixture@example.invalid', 'synthetic');
  client.clear(); finish(session());
  await assert.rejects(login, /fermée/); await assert.rejects(client.token(), /Connectez-vous/);
});
test('old failed renewal cannot erase a newer login', async () => {
  let time = 0; let finish!: (response: Response) => void;
  const client = new BrowserAccount(config, (async (url) => {
    if (requestUrl(url).includes('refresh_token')) return new Promise<Response>((resolve) => { finish = resolve; });
    return session();
  }) as typeof fetch, () => time);
  await client.signIn('a@example.invalid', 'synthetic'); time = 3_550_000;
  const old = client.token(); await client.signIn('b@example.invalid', 'synthetic');
  finish(new Response(null, { status: 401 }));
  await assert.rejects(old); assert.equal(await client.token(), 'fixture-access'); client.clear();
});
test('failed refresh closes session and never falls back to offline authorization', async () => {
  let time = 0;
  const client = new BrowserAccount(config, (async (url) => requestUrl(url).includes('refresh_token') ? new Response(null, { status: 401 }) : session()) as typeof fetch, () => time);
  await client.signIn('fixture@example.invalid', 'synthetic'); time = 3_550_000;
  await assert.rejects(client.token(), /expirée/); await assert.rejects(client.token(), /Connectez-vous/);
});
test('recovery verifies one-time hash before updating password and closes memory afterwards', async () => {
  const calls: string[] = [];
  const client = new BrowserAccount(config, (async (url, init) => {
    calls.push(`${init?.method} ${new URL(requestUrl(url)).pathname}`);
    if (requestUrl(url).endsWith('/verify')) return session();
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  await client.resetPassword({ type: 'recovery', tokenHash: 'a'.repeat(64) }, 'synthetic');
  assert.deepEqual(calls, ['POST /auth/v1/verify', 'PUT /auth/v1/user', 'POST /v1/auth/logout']);
  await assert.rejects(client.token());
});
test('email change requires a session and sends only the new address to Supabase Auth', async () => {
  const requests: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
  const client = new BrowserAccount(config, (async (url, init) => {
    const href = requestUrl(url);
    if (href.includes('/token?')) return session();
    requests.push({
      url: href,
      method: init?.method ?? '',
      authorization: new Headers(init?.headers).get('Authorization'),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : 'null'),
    });
    return Response.json({ id: 'fixture' });
  }) as typeof fetch);
  await assert.rejects(client.changeEmail('next@example.invalid'), /Connectez-vous/);
  await client.signIn('current@example.invalid', 'synthetic');
  await assert.rejects(client.changeEmail('not-an-email'), /Adresse e-mail invalide/);
  await client.changeEmail('  Next+Studio@Example.Invalid ');
  assert.deepEqual(requests, [{
    url: 'https://auth.example.invalid/auth/v1/user',
    method: 'PUT',
    authorization: 'Bearer fixture-access',
    body: { email: 'next+studio@example.invalid' },
  }]);
});
test('email change failure does not falsely report a password problem', async () => {
  const client = new BrowserAccount(config, (async (url) =>
    requestUrl(url).includes('/token?') ? session() : new Response(null, { status: 422 })) as typeof fetch);
  await client.signIn('current@example.invalid', 'synthetic');
  await assert.rejects(client.changeEmail('next@example.invalid'), /Cette adresse e-mail ne peut pas être utilisée/);
});
test('mutating requests are not automatically retried after an uncertain response', async () => {
  let attempts = 0;
  const client = new BrowserAccount(config, (async (url) => {
    if (requestUrl(url).includes('/token?')) return session();
    attempts++; throw new TypeError('network fixture');
  }) as typeof fetch);
  await client.signIn('fixture@example.invalid', 'synthetic');
  await assert.rejects(client.checkout('fixture', 'https://site.example.invalid/'), /Vérifiez le résultat/);
  assert.equal(attempts, 1); client.clear();
});
test('public catalogue is display-only and rejects malformed amounts', () => {
  const offer = { selectionId: 'fixture', offerCode: 'studio', displayName: 'Studio', description: null, billingInterval: 'month', currency: 'EUR', unitAmountMinor: 1234, testMode: true };
  const free = { offerCode: 'discovery', displayName: 'Gratuite', description: 'Fixture', featured: false, features: ['Fixture'], prices: [{ selectionId: null, billingInterval: 'none', currency: 'EUR', unitAmountMinor: 0, testMode: true }] };
  const paid = (offerCode: 'author_ai' | 'studio') => ({ offerCode, displayName: 'Fixture', description: 'Fixture', featured: false, features: ['Fixture'], prices: [
    { selectionId: `${offerCode}-month`, billingInterval: 'month', currency: 'EUR', unitAmountMinor: 1234, testMode: true },
    { selectionId: `${offerCode}-year`, billingInterval: 'year', currency: 'EUR', unitAmountMinor: 12_340, testMode: true },
  ] });
  const catalog = { contractVersion: '2026-09-v11', environment: 'test', testMode: true, offers: [offer], plans: [free, paid('author_ai'), paid('studio')], request_id: 'fixture' };
  assert.equal(readPublicBetaCatalog(catalog).offers[0].unitAmountMinor, 1234);
  assert.equal(readPublicBetaCatalog({ ...catalog, environment: 'production', testMode: false }).testMode, false);
  assert.throws(() => readPublicBetaCatalog({ ...catalog, offers: [{ ...offer, unitAmountMinor: NaN }] }));
  assert.throws(() => readPublicBetaCatalog({ ...catalog, plans: [free, paid('author_ai'), paid('author_ai')] }));
  assert.throws(() => readPublicBetaCatalog({ ...catalog, plans: [{ ...free, prices: [{ ...free.prices[0], unitAmountMinor: 1 }] }, paid('author_ai'), paid('studio')] }));
});
