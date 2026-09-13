import type { EntitlementSnapshot } from './contracts.ts';

export const COMMERCIAL_CONTRACT_VERSION_V3 = '2026-09-v3';

export type BillingInterval = 'month' | 'year';
export type BillingStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'canceled'
  | 'expired';

export interface BillingOfferView {
  selectionId: string;
  offerCode: 'author_ai' | 'studio';
  displayName: string;
  description: string | null;
  billingInterval: BillingInterval;
  currency: string;
  unitAmountMinor: number;
  testMode: boolean;
}

export interface BillingState {
  status: BillingStatus;
  offerCode: string | null;
  offerDisplayName: string | null;
  billingInterval: BillingInterval | null;
  currentPeriodStartsAt: string | null;
  currentPeriodEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  lastPaymentStatus: 'paid' | 'failed' | null;
  source: 'stripe' | 'activation_key' | 'admin_grant' | null;
  testMode: boolean;
}

export interface BillingOverviewResponse {
  offers: BillingOfferView[];
  billing: BillingState;
  request_id: string;
}

export interface CheckoutSessionRequest {
  selectionId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSessionResponse {
  checkoutUrl: string;
  expiresAt: string;
  testMode: boolean;
  request_id: string;
}

export interface BillingPortalResponse {
  portalUrl: string;
  testMode: boolean;
  request_id: string;
}

export interface ActivationRedemptionView {
  id: string;
  keySuffix: string;
  status: 'active' | 'revoked' | 'expired';
  activatedAt: string;
  expiresAt: string | null;
  deviceId: string | null;
}

export interface ActivationStatusResponse {
  activations: ActivationRedemptionView[];
  request_id: string;
}

export interface ActivationRedeemResponse {
  activation: ActivationRedemptionView;
  snapshot: EntitlementSnapshot;
  request_id: string;
}

export interface LocalActivationKeyCreation {
  id: string;
  key: string;
  keySuffix: string;
  expiresAt: string | null;
  maximumActivations: number;
}
