// Read-only post-deployment check in an isolated browser; never starts a download.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const origin = process.env.SCENARIO_TEST_SITE_URL ?? 'https://senario.app';
assert.ok(['https://senario.app', 'http://127.0.0.1:4173'].includes(origin));
const version = process.argv[2];
assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
const { chromium } = await import(process.env.SCENARIO_PLAYWRIGHT_PATH
  ? pathToFileURL(process.env.SCENARIO_PLAYWRIGHT_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(`${origin}/telecharger`, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    assert.ok(await page.getByRole('heading', { name: `Senario ${version}`, exact: true }).isVisible());
    const download = page.getByRole('link', { name: /Télécharger pour Windows/ });
    assert.ok(await download.isVisible());
    assert.equal(await download.getAttribute('href'), 'https://github.com/orestispic/scenario-app/releases/latest/download/Scenario-Setup.exe');
    assert.ok(await page.getByRole('link', { name: /offres/i }).first().isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS download ${version}: ${width}px, live route, stable installer link, offers navigation, no renderer error`);
  }
} finally { await browser.close(); }
