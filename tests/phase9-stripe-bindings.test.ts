/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

import { validateStripePriceIds } from '../scripts/phase9-bind-stripe-prices.mjs';

const valid = {
  '--author-month': 'price_AuthorMonth123',
  '--author-year': 'price_AuthorYear123',
  '--studio-month': 'price_StudioMonth123',
  '--studio-year': 'price_StudioYear123',
};

test('phase 9 Stripe bindings accept only four distinct non-secret Price ids', () => {
  assert.equal(validateStripePriceIds(valid).length, 4);
  assert.throws(() =>
    validateStripePriceIds({ ...valid, '--studio-year': 'sk_test_forbidden' }),
  );
  assert.throws(() =>
    validateStripePriceIds({
      ...valid,
      '--studio-year': valid['--studio-month'],
    }),
  );
});

test('the binding script validates the server catalogue and stays environment-neutral', async () => {
  const source = await readFile(
    new URL('../scripts/phase9-bind-stripe-prices.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /offer_configuration_items/);
  assert.match(source, /price_minor/);
  assert.match(source, /Supabase project identity does not match/);
  assert.doesNotMatch(
    source,
    /price_1UEpf8RDbrwbCdY0IjwGAlq0|sk_test_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/,
  );
});

test('the current Stripe API migration preserves raw events and reconciles item periods', async () => {
  const sql = await readFile(
    new URL(
      '../supabase/migrations/20260920000000_stripe_current_api_periods.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /apply_verified_stripe_event_phase4/);
  assert.match(sql, /items,data,0,current_period_start/);
  assert.match(sql, /items,data,0,current_period_end/);
  assert.match(sql, /current_period_starts_at=v_period_start/);
  assert.match(sql, /public\.entitlement_payload_for_price/);
  assert.match(sql, /on conflict \(source_event_id\)[\s\S]*do nothing/);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /sk_(?:test|live)_|whsec_|['"]price_[A-Za-z0-9]/);
});
