/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateAdminGrantInput } from '../scripts/grant-admin-offer.mjs';

test('administrative grants accept only paid offers and valid explicit identities', () => {
  assert.deepEqual(validateAdminGrantInput({ email: 'User@Example.test', offer: 'studio', reason: 'Support account', expiresAt: undefined }), {
    email: 'user@example.test', offer: 'studio', reason: 'Support account', expiresAt: null,
  });
  assert.throws(() => validateAdminGrantInput({ email: 'invalid', offer: 'studio', reason: 'Support account', expiresAt: undefined }));
  assert.throws(() => validateAdminGrantInput({ email: 'u@example.test', offer: 'discovery', reason: 'Support account', expiresAt: undefined }));
  assert.throws(() => validateAdminGrantInput({ email: 'u@example.test', offer: 'studio', reason: 'x', expiresAt: undefined }));
});

test('administrative offer RPC is server-only, audited and distinct from Stripe', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260926000000_admin_offer_grants.sql', import.meta.url), 'utf8');
  assert.match(sql, /source[^\n]+admin_grant/);
  assert.match(sql, /admin\.offer_granted/);
  assert.match(sql, /revoke all on function public\.grant_admin_offer[\s\S]+from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.grant_admin_offer[\s\S]+to service_role/);
  assert.doesNotMatch(sql, /support@senario\.app|sk_(?:test|live)_|whsec_/);
  const fix = await readFile(new URL('../supabase/migrations/20260926100000_admin_offer_grant_catalog_fix.sql', import.meta.url), 'utf8');
  assert.match(fix, /create or replace function public\.grant_admin_offer/);
  assert.doesNotMatch(fix, /item\.created_at/);
});
