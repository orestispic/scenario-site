/* oxlint-disable typescript/no-floating-promises */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/localRuntime.ts';
import { readPublicBetaCatalog } from '../../lib/commercial/contracts-v11.ts';
test('public test catalogue is anonymous but cannot expose provider IDs / grant rights', async () => {
  const runtime = await createLocalRuntime({ telemetry: { record() {} } });
  const result = await runtime.worker.fetch(new Request('http://localhost/v11/catalog'));
  assert.equal(result.status, 200);
  const catalog = readPublicBetaCatalog(await result.json());
  assert.equal(catalog.offers.length, 4);
  assert.equal(catalog.request_id, result.headers.get('x-request-id'));
  assert.doesNotMatch(JSON.stringify(catalog), /providerPrice|quota|entitlement|deviceLimit|@|price_test/);
  assert.equal((await runtime.worker.fetch(new Request('http://localhost/v1/me'))).status, 401);
});
test('public catalogue preserves CORS, method and fail-closed rate checks', async () => {
  const runtime = await createLocalRuntime({ telemetry: { record() {} } });
  assert.equal((await runtime.worker.fetch(new Request('http://localhost/v11/catalog', { headers: { Origin: 'https://evil.invalid' } }))).status, 403);
  assert.equal((await runtime.worker.fetch(new Request('http://localhost/v11/catalog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status, 405);
  const denied = await createLocalRuntime({ ingressRateLimiter: { allow: async () => false }, telemetry: { record() {} } });
  assert.equal((await denied.worker.fetch(new Request('http://localhost/v11/catalog'))).status, 429);
});
