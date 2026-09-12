/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

test('phase 9 publishes the documented catalogue only on the server', async () => {
  const sql = await readFile(
    new URL(
      '../supabase/migrations/20260918000000_initial_commercial_catalog.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const compactSql = sql.replace(/\s+/g, ' ');

  assert.match(compactSql, /'discovery'.*'author_ai'.*'studio'/);
  assert.match(sql, /'month', 'EUR', 880,/);
  assert.match(sql, /'year', 'EUR', 8800,/);
  assert.match(sql, /'month', 'EUR', 1500,/);
  assert.match(sql, /'year', 'EUR', 15000,/);
  assert.match(sql, /\('author_ai', 'ai_short_action', 600\)/);
  assert.match(sql, /\('author_ai', 'ai_pdf_import', 3\)/);
  assert.match(sql, /\('studio', 'ai_short_action', 2000\)/);
  assert.match(sql, /\('studio', 'ai_pdf_import', 15\)/);
  assert.match(sql, /'windows', 'stable', '0\.1\.7'/);
  assert.match(sql, /'macos', 'stable', '0\.1\.7'/);
  assert.doesNotMatch(sql, /price_(?:test|live)_/);
  assert.doesNotMatch(sql, /sk_(?:test|live)_|whsec_/);
});
