import type { BillingState } from '../../lib/commercial/contracts-v3.ts';

/** Server policy: at most 30 days and never beyond the paid entitlement term. */
export function offlineLeaseUntil(billing: BillingState, existingUntil: string, now: number): string {
  const paidUntil = Date.parse(billing.currentPeriodEndsAt ?? '');
  if (['active', 'canceled'].includes(billing.status) && billing.lastPaymentStatus === 'paid' && Number.isFinite(paidUntil) && paidUntil > now) {
    const day = 86_400_000;
    return new Date(Math.min(paidUntil, now + 30 * day)).toISOString();
  }
  // Grants and trials retain their existing server expiration, never extend locally.
  return existingUntil;
}
