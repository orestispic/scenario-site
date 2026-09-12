import type { BillingOfferView } from './contracts-v3.ts';

/** Public, display-only catalogue. Does not confer any account entitlement. */
export interface PublicBetaCatalog {
  contractVersion: '2026-09-v11';
  environment: 'test' | 'staging' | 'production';
  testMode: true;
  offers: BillingOfferView[];
  request_id: string;
}

export function readPublicBetaCatalog(value: unknown): PublicBetaCatalog {
  const body = value as PublicBetaCatalog | null;
  if (!body || body.contractVersion !== '2026-09-v11' || body.testMode !== true ||
      !['test', 'staging', 'production'].includes(body.environment) ||
      typeof body.request_id !== 'string' || !Array.isArray(body.offers) || body.offers.length > 100)
    throw new Error('Catalogue temporairement indisponible.');
  for (const offer of body.offers) {
    if (!offer || typeof offer.selectionId !== 'string' ||
        !['author_ai', 'studio'].includes(offer.offerCode) ||
        typeof offer.displayName !== 'string' || offer.displayName.length > 200 ||
        !(offer.description === null || typeof offer.description === 'string') ||
        !['month', 'year'].includes(offer.billingInterval) ||
        typeof offer.currency !== 'string' || !/^[A-Za-z]{3}$/.test(offer.currency) ||
        !Number.isSafeInteger(offer.unitAmountMinor) || offer.unitAmountMinor < 0 || offer.testMode !== true)
      throw new Error('Catalogue temporairement indisponible.');
  }
  return body;
}
