import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offlineLeaseUntil } from '../src/offlineLease.ts';
import type { BillingState } from '../../lib/commercial/contracts-v3.ts';

test('bounds monthly and annual offline periods and does not extend unpaid grants', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const billing = { status: 'active', lastPaymentStatus: 'paid', billingInterval: 'month', currentPeriodEndsAt: '2026-10-01T00:00:00Z' } as BillingState;
  assert.equal(offlineLeaseUntil(billing, '2026-09-08T00:00:00Z', now), '2026-10-04T00:00:00.000Z');
  assert.equal(offlineLeaseUntil({ ...billing, billingInterval: 'year', currentPeriodEndsAt: '2027-09-01T00:00:00Z' }, '', now), '2026-10-01T00:00:00.000Z');
  assert.equal(offlineLeaseUntil({ ...billing, lastPaymentStatus: 'failed' }, '2026-09-08T00:00:00Z', now), '2026-09-08T00:00:00Z');
});
