/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

import { validateStripePriceIds } from '../scripts/phase9-bind-stripe-prices.mjs';
import { validateCheckoutPayload } from '../scripts/phase9-create-test-checkout.mjs';

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

test('the hosted catalogue validation logs out and never prints credentials', async () => {
  const source = await readFile(
    new URL('../scripts/phase9-validate-stripe-catalog.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /\/v2\/billing/);
  assert.match(source, /auth\/v1\/logout\?scope=local/);
  assert.match(source, /payload\.offers\.length !== EXPECTED\.size/);
  assert.doesNotMatch(source, /console\.log\([^)]*(?:password|access_token)/);
});

test('the hosted Checkout launcher accepts only fresh Stripe test Checkout URLs', () => {
  const checkoutUrl =
    'https://checkout.stripe.com/c/pay/cs_test_example#fragment';
  assert.equal(
    validateCheckoutPayload({
      checkoutUrl,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      testMode: true,
      request_id: 'request-example',
    }),
    checkoutUrl,
  );
  assert.throws(() =>
    validateCheckoutPayload({
      checkoutUrl: 'https://example.invalid/c/pay/cs_test_example',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      testMode: true,
      request_id: 'request-example',
    }),
  );
  assert.throws(() =>
    validateCheckoutPayload({
      checkoutUrl,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      testMode: false,
      request_id: 'request-example',
    }),
  );
});

test('the hosted Checkout launcher is fixed to Studio monthly and logs out', async () => {
  const source = await readFile(
    new URL('../scripts/phase9-create-test-checkout.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /const OFFER_CODE = 'studio'/);
  assert.match(source, /const BILLING_INTERVAL = 'month'/);
  assert.match(source, /auth\/v1\/logout\?scope=local/);
  assert.match(source, /checkout\.stripe\.com/);
  assert.doesNotMatch(source, /sk_(?:test|live)_|whsec_|price_1UEp/);
});

test('the hosted Checkout validator proves processed webhooks and subscription rights', async () => {
  const source = await readFile(
    new URL('../scripts/phase9-validate-test-checkout.mjs', import.meta.url),
    'utf8',
  );
  for (const eventType of [
    'checkout.session.completed',
    'customer.subscription.created',
    'invoice.paid',
  ])
    assert.match(source, new RegExp(eventType.replace('.', '\\.')));
  assert.match(source, /billing\.offerCode !== 'studio'/);
  assert.match(source, /billing\.billingInterval !== 'month'/);
  assert.match(source, /studio_collaboration/);
  assert.match(source, /cloud\.sync/);
  assert.match(source, /auth\/v1\/logout\?scope=local/);
  assert.doesNotMatch(source, /console\.log\([^)]*(?:password|access_token)/);
});

test('the Stripe webhook order migration links paid invoices without changing raw events', async () => {
  const sql = await readFile(
    new URL(
      '../supabase/migrations/20260921000000_stripe_webhook_order_reconciliation.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /apply_verified_stripe_event_phase9_periods/);
  assert.match(sql, /invoice\.subscription_id is null/);
  assert.match(sql, /customer\.subscription\.%/);
  assert.match(sql, /parent,subscription_details,subscription/);
  assert.match(
    sql,
    /lines,data,0,parent,subscription_item_details,subscription/,
  );
  assert.match(sql, /webhook\.processing_status='processed'/);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/);
  assert.doesNotMatch(
    sql,
    /update public\.stripe_webhook_events|delete from public\.stripe_webhook_events/,
  );
});
