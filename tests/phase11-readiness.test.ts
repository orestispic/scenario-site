/* oxlint-disable typescript/no-floating-promises */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publicationBlockers } from '../scripts/phase11-readiness.mjs';
test('publication remains blocked; absence or string truthy values cannot unlock a gate', () => {
  const plan = JSON.parse(readFileSync(new URL('../release/publication-plan.json', import.meta.url), 'utf8'));
  assert.equal(publicationBlockers(plan).length, 10);
  assert.ok(publicationBlockers({ schemaVersion: 1, brand: 'senario', publicationAuthorized: 'true' }).length > 0);
  assert.ok(publicationBlockers({}).length > 0);
});
test('commercial production entry never builds legacy download or analytics entry', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../src/beta.tsx', import.meta.url), 'utf8');
  assert.match(html, /src\/beta\.tsx/); assert.match(html, /noindex/);
  assert.doesNotMatch(entry, /releases\/latest|@vercel\/analytics|localStorage|sessionStorage/);
});
test('all 17 historical migrations including phase 10 remain immutable', () => {
  const hashes: Record<string, string> = JSON.parse(readFileSync(new URL('../release/migrations-phase10.sha256.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(hashes).length, 17);
  for (const [name, expected] of Object.entries(hashes)) {
    const bytes = readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, name);
  }
});
