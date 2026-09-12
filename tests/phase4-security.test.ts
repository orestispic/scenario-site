/* oxlint-disable typescript/no-floating-promises */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('phase 0–3 migrations remain byte-for-byte immutable (normalized line endings)', async () => {
  const hashes = {
    '20260910000000_commercial_foundation.sql':
      'a38684bc511833af8fb1171bdaf1b2c9c0a8a2572a66528f6e0989bc75747c8d',
    '20260911000000_auth_rls.sql':
      '6a8584cce74ffa6d1d6bb422c6a49ff17e0271ab215b1a517fb3771304618448',
    '20260912000000_stripe_billing_activation.sql':
      '193ba98c9661b071c8457176cdb8c55dfc88e4dd0ed13237e0e16418ccc8cfa8',
  };
  for (const [file, hash] of Object.entries(hashes)) {
    const source = await readFile(
      new URL(`../supabase/migrations/${file}`, import.meta.url),
      'utf8',
    );
    assert.equal(
      createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex'),
      hash,
      file,
    );
  }
});

test('phase 4 RPCs keep least privilege, ordering and revocation checks', async () => {
  const sql = await readFile(
    new URL(
      '../supabase/migrations/20260913000000_preproduction_hardening.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /key\.revoked_at is null/);
  assert.match(sql, /p_payload -> 'livemode' is distinct from 'false'::jsonb/);
  assert.match(sql, /event_payload_mismatch/);
  assert.match(sql, /from public, anon, authenticated, service_role/);
  assert.doesNotMatch(
    sql,
    /grant (insert|update|delete|all) .* to authenticated/,
  );
  const entry = await readFile(
    new URL('../worker/src/index.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    entry,
    /InMemoryRateLimiter|localRuntime|localAuth|LocalTest/,
  );
  const config = await readFile(
    new URL('../wrangler.preproduction.toml', import.meta.url),
    'utf8',
  );
  assert.match(config, /SCENARIO_ENVIRONMENT = "staging"/);
  assert.match(config, /new_sqlite_classes = \["RateLimitBucket"\]/);
  assert.match(config, /workers_dev = true/);
  assert.match(config, /preview_urls = false/);
  assert.match(config, /http:\/\/127\.0\.0\.1:1420/);
});
