// Isolated browser. Default: all remote requests intercepted; no email/payment.
// --hosted: existing synthetic Owner login + read-only catalogue/account only.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createLocalRuntime } from '../worker/src/localRuntime.ts';

const hosted = process.argv.includes('--hosted');
const origin = process.env.SCENARIO_TEST_SITE_URL ?? 'http://127.0.0.1:4173';
if (!['http://127.0.0.1:4173', 'http://127.0.0.1:4174', 'https://scenario-site-5w3cp0w67-orepicard-4993s-projects.vercel.app'].includes(origin))
  throw new Error('Refusing an unexpected site origin');
const api = 'https://scenario-commercial-api-preproduction.ore-picard.workers.dev';
const auth = 'https://zblnsdyaoljnezxdidtx.supabase.co';
const { chromium } = await import(process.env.SCENARIO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.SCENARIO_PLAYWRIGHT_PATH).href : 'playwright');
const runtime = await createLocalRuntime({ allowedOrigins: [origin], telemetry: { record() {} } });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const failures = []; let recovered = 0; let changed = 0; let checkout = 0; let confirmed = 0;
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin === origin) return route.continue();
  if (hosted) {
    if (url.origin === auth && url.pathname === '/auth/v1/token') return route.continue();
    if (url.origin === api && (request.method() === 'GET' || url.pathname === '/v1/auth/logout' || request.method() === 'OPTIONS')) return route.continue();
    return route.abort();
  }
  if (url.origin === auth) {
    if (url.pathname === '/auth/v1/verify' && JSON.parse(request.postData() ?? '{}').type === 'signup') confirmed++;
    if (url.pathname === '/auth/v1/recover') recovered++;
    if (url.pathname === '/auth/v1/user') { assert.equal(request.method(), 'PUT'); changed++; }
    const data = ['/auth/v1/token', '/auth/v1/verify'].includes(url.pathname)
      ? { access_token: 'local-test:studio', refresh_token: 'synthetic-memory-refresh', expires_in: 3600 } : {};
    return route.fulfill({ status: 200, json: data, headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'apikey, authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' } });
  }
  if (url.origin === api) {
    if (url.pathname === '/v2/checkout/sessions' && request.method() === 'POST') {
      checkout++;
      return route.fulfill({ json: { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_isolated', testMode: true }, headers: { 'access-control-allow-origin': origin } });
    }
    const response = await runtime.worker.fetch(new Request(`http://localhost${url.pathname}`, {
      method: request.method(), headers: await request.allHeaders(), ...(request.postData() ? { body: request.postData() } : {}),
    }));
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  }
  if (url.origin === 'https://checkout.stripe.com') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>Checkout simulé, aucun paiement</h1>' });
  return route.abort();
});
const page = await context.newPage();
page.on('requestfailed', (request) => { if (new URL(request.url()).pathname === '/v11/catalog') console.log('Catalogue network failure:', request.failure()?.errorText); });
page.on('pageerror', () => failures.push('Browser exception (details intentionally omitted)'));
function environment(path) {
  return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
}
try {
  await page.goto(origin); await page.getByRole('heading', { name: 'Les offres de la bêta' }).waitFor();
  await page.locator('#offres .offer').first().waitFor({ timeout: 15_000 }).catch(async () => {
    console.log('Catalogue readiness:', await page.locator('.notice').allTextContents());
    throw new Error('Catalogue unavailable before synthetic login');
  });
  assert.equal(await page.locator('#offres .offer').count(), 3);
  assert.deepEqual(await page.locator('#offres .offer h3').allTextContents(), ['Gratuite', 'Auteur', 'Studio']);
  assert.equal(await page.getByRole('switch', { name: 'Afficher les prix mensuels' }).first().getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#offres .offer').nth(1).getByText(/facturés par an/).count(), 1);
  await page.getByRole('switch', { name: 'Afficher les prix mensuels' }).first().click();
  assert.equal(await page.getByRole('switch', { name: 'Afficher les prix annuels' }).first().getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#offres .offer').nth(1).getByText('Facturation mensuelle').count(), 1);
  await page.getByRole('switch', { name: 'Afficher les prix annuels' }).first().click();
  assert.equal(await page.locator('a[href*="releases/latest/download"]').count(), 0);
  assert.equal(await page.locator('script[src*="analytics"]').count(), 0);
  let email = 'synthetic@example.invalid', password = 'synthetic-password';
  if (hosted) { const values = environment('.env.phase9.accounts.local'); email = values.PHASE9_OWNER_EMAIL; password = values.PHASE9_OWNER_PASSWORD; }
  await page.getByLabel('Adresse e-mail', { exact: true }).fill(email);
  if (!hosted) {
    await page.getByRole('button', { name: 'Mot de passe oublié ?' }).click();
    await page.getByRole('status').getByText(/un lien de récupération sera envoyé/).waitFor(); assert.equal(recovered, 1);
  }
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.getByRole('button', { name: 'Se déconnecter', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  mkdirSync('outputs', { recursive: true });
  await page.screenshot({ path: `outputs/phase11-site-${hosted ? 'hosted' : 'local'}-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Actualiser mon compte' }).click();
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await page.getByRole('status').getByText('Vous êtes déconnecté.').waitFor();
  if (!hosted) {
    await page.getByLabel('Adresse e-mail', { exact: true }).fill(email);
    await page.getByLabel('Mot de passe', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
    await page.getByRole('button', { name: 'Essayer Auteur en mode test' }).click();
    await page.getByRole('heading', { name: 'Checkout simulé, aucun paiement' }).waitFor({ timeout: 10_000 }).catch(async () => {
      console.log('Checkout fixture attempts:', checkout, 'UI status:', await page.locator('#compte output').allTextContents());
      throw new Error('Simulated Checkout navigation failed');
    }); assert.equal(checkout, 1);
    await page.goto(`${origin}/#token_hash=${'a'.repeat(64)}&type=recovery`);
    await page.getByLabel('Nouveau mot de passe', { exact: true }).fill('synthetic-new-password');
    assert.equal(page.url(), `${origin}/#compte`);
    await page.getByRole('button', { name: 'Modifier mon mot de passe' }).click();
    await page.getByRole('status').getByText(/Mot de passe modifié/).waitFor(); assert.equal(changed, 1);
    await page.goto(`${origin}/#token_hash=${'b'.repeat(64)}&type=signup`);
    await page.getByRole('button', { name: 'Confirmer mon adresse', exact: true }).waitFor();
    assert.equal(page.url(), `${origin}/#compte`); assert.equal(confirmed, 0);
    await page.getByRole('button', { name: 'Confirmer mon adresse', exact: true }).click();
    await page.getByRole('status').getByText(/Adresse confirmée/).waitFor(); assert.equal(confirmed, 1);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    for (const section of ['support', 'confidentialite', 'conditions', 'mentions'])
      assert.equal(await page.locator(`#${section} h2`).count(), 1);
  }
  assert.deepEqual(failures, []);
  console.log(`PASS ${hosted ? 'HOSTED Supabase/Cloudflare (read-only)' : 'LOCAL simulated'}: catalogue, account, logout, mobile, no browser token storage${hosted ? '' : ', recovery, reset, Checkout redirect'}.`);
} finally { await context.close(); await browser.close(); }
