import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';

const script = await readFile(
  '.wrangler/phase4-preproduction/index.js',
  'utf8',
);
assert.doesNotMatch(
  script,
  /LocalAuthService|LocalTestRepository|local-billing-v1|price_test_author|whsec_local_fixture_only/,
);
const runtime = new Miniflare({
  modules: true,
  script,
  compatibilityDate: '2026-05-22',
  compatibilityFlags: ['nodejs_compat'],
  durableObjects: {
    RATE_LIMITER: { className: 'RateLimitBucket', useSQLite: true },
  },
});
try {
  const namespace = await runtime.getDurableObjectNamespace('RATE_LIMITER');
  const id = namespace.idFromName('runtime-fixture-subject');
  const request = () =>
    namespace.get(id).fetch('http://limiter/check', {
      method: 'POST',
      body: JSON.stringify({ maximum: 5, windowMs: 1000 }),
    });
  const responses = await Promise.all(Array.from({ length: 40 }, request));
  const results = await Promise.all(
    responses.map((response) => response.json()),
  );
  assert.equal(results.filter((result) => result.allowed).length, 5);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await (await request()).json()).allowed, true);
  console.log(
    'Cloudflare workerd/SQLite: 40 concurrent requests, exactly 5 accepted; expiry recovery passed. Production bundle isolated.',
  );
} finally {
  await runtime.dispose();
}
