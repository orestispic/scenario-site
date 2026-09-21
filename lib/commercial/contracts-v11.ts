import type { BillingOfferView } from './contracts-v3.ts';

export type PublicPlanCode = 'discovery' | 'author_ai' | 'studio';
export type PublicPlanInterval = 'none' | 'month' | 'year';

export interface PublicPlanPrice {
  selectionId: string | null;
  billingInterval: PublicPlanInterval;
  currency: string;
  unitAmountMinor: number;
  testMode: boolean;
}

/** Marketing copy only. Effective rights are always resolved again by the API. */
export interface PublicPlanView {
  offerCode: PublicPlanCode;
  displayName: string;
  description: string;
  featured: boolean;
  features: string[];
  prices: PublicPlanPrice[];
}

/** Public, display-only catalogue. Does not confer any account entitlement. */
export interface PublicBetaCatalog {
  contractVersion: '2026-09-v11';
  environment: 'test' | 'staging' | 'production';
  testMode: boolean;
  /** Kept for v11 consumers that still render one card per billing selection. */
  offers: BillingOfferView[];
  plans: PublicPlanView[];
  request_id: string;
}

export function readPublicBetaCatalog(value: unknown): PublicBetaCatalog {
  const body = value as PublicBetaCatalog | null;
  if (!body || body.contractVersion !== '2026-09-v11' || typeof body.testMode !== 'boolean' ||
      !['test', 'staging', 'production'].includes(body.environment) ||
      typeof body.request_id !== 'string' || !Array.isArray(body.offers) || body.offers.length > 100 ||
      !Array.isArray(body.plans) || body.plans.length !== 3)
    throw new Error('Catalogue temporairement indisponible.');
  for (const offer of body.offers) {
    if (!offer || typeof offer.selectionId !== 'string' ||
        !['author_ai', 'studio'].includes(offer.offerCode) ||
        typeof offer.displayName !== 'string' || offer.displayName.length > 200 ||
        !(offer.description === null || typeof offer.description === 'string') ||
        !['month', 'year'].includes(offer.billingInterval) ||
        typeof offer.currency !== 'string' || !/^[A-Za-z]{3}$/.test(offer.currency) ||
        !Number.isSafeInteger(offer.unitAmountMinor) || offer.unitAmountMinor < 0 || typeof offer.testMode !== 'boolean')
      throw new Error('Catalogue temporairement indisponible.');
  }
  const expectedIntervals = new Map<PublicPlanCode, PublicPlanInterval[]>([
    ['discovery', ['none']], ['author_ai', ['month', 'year']], ['studio', ['month', 'year']],
  ]);
  const seen = new Set<PublicPlanCode>();
  for (const plan of body.plans) {
    if (!plan || !expectedIntervals.has(plan.offerCode) || seen.has(plan.offerCode) ||
        typeof plan.displayName !== 'string' || plan.displayName.length < 1 || plan.displayName.length > 100 ||
        typeof plan.description !== 'string' || plan.description.length > 300 ||
        typeof plan.featured !== 'boolean' || !Array.isArray(plan.features) || plan.features.length < 1 || plan.features.length > 20 ||
        plan.features.some((feature) => typeof feature !== 'string' || feature.length < 1 || feature.length > 200) ||
        !Array.isArray(plan.prices))
      throw new Error('Catalogue temporairement indisponible.');
    seen.add(plan.offerCode);
    const expected = expectedIntervals.get(plan.offerCode)!;
    if (plan.prices.length !== expected.length ||
        [...plan.prices].map((price) => price.billingInterval).sort().join(',') !== [...expected].sort().join(','))
      throw new Error('Catalogue temporairement indisponible.');
    for (const price of plan.prices) {
      if (!price || !expected.includes(price.billingInterval) ||
          !(price.selectionId === null || typeof price.selectionId === 'string') ||
          (price.billingInterval === 'none' ? price.selectionId !== null : !price.selectionId) ||
          typeof price.currency !== 'string' || !/^[A-Za-z]{3}$/.test(price.currency) ||
          !Number.isSafeInteger(price.unitAmountMinor) || price.unitAmountMinor < 0 ||
          (price.billingInterval === 'none' && price.unitAmountMinor !== 0) || typeof price.testMode !== 'boolean')
        throw new Error('Catalogue temporairement indisponible.');
    }
  }
  return body;
}
