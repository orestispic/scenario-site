import type { BillingState } from '../../lib/commercial/contracts-v3.ts';

/** Server policy: monthly paid term + 3 days; annual checks at most every 30 days. */
export function offlineLeaseUntil(billing: BillingState, existingUntil: string, now: number): string {
  const paidUntil = Date.parse(billing.currentPeriodEndsAt ?? '');
  if (billing.status === 'active' && billing.lastPaymentStatus === 'paid' && Number.isFinite(paidUntil) && paidUntil > now) {
    const day = 86_400_000;
    return new Date(billing.billingInterval === 'month'
      ? Math.min(paidUntil + 3 * day, now + 34 * day)
      : Math.min(paidUntil, now + 30 * day)).toISOString();
  }
  // Grants and trials retain their existing server expiration, never extend locally.
  return existingUntil;
}
