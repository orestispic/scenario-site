import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createLocalRuntime } from '../worker/src/localRuntime.ts';
const { chromium } = await import(pathToFileURL(process.env.SCENARIO_PLAYWRIGHT_PATH).href);
const base = process.env.SENARIO_SITE_TEST_URL || 'http://127.0.0.1:4174';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const runtime = await createLocalRuntime({ allowedOrigins: [base], telemetry: { record() {} } });
  const catalog = await (await runtime.worker.fetch(new Request('http://localhost/v11/catalog'))).json();
  const authorYear = catalog.plans.find(plan => plan.offerCode === 'author_ai').prices.find(price => price.billingInterval === 'year');
  const expectedMonthly = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(authorYear.unitAmountMinor / 1200);
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!/^\/v\d+\//.test(url.pathname)) return url.origin === base ? route.continue() : route.abort();
      const response = await runtime.worker.fetch(new Request(`http://localhost${url.pathname}${url.search}`, { method: request.method(), headers: request.headers() }));
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/offres`);
    const toggle = page.getByRole('switch');
    await toggle.waitFor();
    assert.deepEqual(await page.locator('.billing-control>span').allTextContents(), ['Mensuel', 'Annuel']);
    assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'Annual remains the default, knob on the right');
    await page.locator('.offer-grid article').first().waitFor();
    const annual = await page.locator('.offer-grid').textContent();
    assert.ok(annual.includes(expectedMonthly), 'Annual display is the server annual amount divided by twelve');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    const monthly = await page.locator('.offer-grid').textContent();
    assert.notEqual(annual, monthly);
    await toggle.click();
    assert.equal(await page.locator('.offer-grid').textContent(), annual);
    const icon = page.locator('link[rel="icon"]');
    assert.equal(await icon.getAttribute('href'), '/scenario-logo.png');
    const image = await page.request.get(`${base}/scenario-logo.png`);
    assert.equal(image.status(), 200);
    assert.ok((image.headers()['content-type'] ?? '').includes('image/png'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await mkdir('outputs/offers-favicon', { recursive: true });
    await page.screenshot({ path: `outputs/offers-favicon/offers-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: monthly left, annual right/default, prices toggle and logo favicon`);
    await context.close();
  }
} finally { await browser.close(); }
