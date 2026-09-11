import type {
  ActivationRedemptionView,
  BillingOfferView,
  BillingState,
} from '../../lib/commercial/contracts-v3.ts';
import type { EntitlementSnapshot } from '../../lib/commercial/contracts.ts';
import type { VerifiedStripeEvent } from './stripeWebhook.ts';
import type { ActivateDeviceInput, WorkerEnvironment } from './types.ts';

export interface CheckoutSelection extends BillingOfferView {
  providerPriceReference: string;
}

export interface BillingRepository {
  listOffers(): Promise<BillingOfferView[]>;
  getSelection(selectionId: string): Promise<CheckoutSelection | null>;
  getBillingState(profileId: string): Promise<BillingState>;
  getCustomerReference(profileId: string): Promise<string | null>;
  recordCheckoutSession(input: {
    profileId: string;
    selectionId: string;
    providerSessionId: string;
    expiresAt: string;
  }): Promise<void>;
  applyStripeEvent(
    event: VerifiedStripeEvent,
    rawBody: string,
  ): Promise<{ replayed: boolean }>;
  listActivations(profileId: string): Promise<ActivationRedemptionView[]>;
  redeemActivationKey(input: {
    profileId: string;
    keyHash: string;
    device: ActivateDeviceInput;
  }): Promise<{
    activation: ActivationRedemptionView;
    snapshot: EntitlementSnapshot;
  }>;
  revokeActivationKey(input: {
    keyId: string;
    actorProfileId: string;
  }): Promise<void>;
}

type DatabaseOffer = {
  id: string;
  provider_price_id: string;
  offer_configuration_items: {
    display_name: string;
    description: string | null;
    billing_period: 'month' | 'year';
    currency: string;
    price_minor: number;
    offers: { offer_code: 'author_ai' | 'studio' };
  };
};

export class SupabaseBillingRepository implements BillingRepository {
  constructor(
    private readonly environment: WorkerEnvironment,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async listOffers(): Promise<BillingOfferView[]> {
    const rows = await this.read<DatabaseOffer[]>(
      '/rest/v1/prices?provider=eq.stripe&provider_price_id=not.is.null&active_until=is.null&select=id,provider_price_id,offer_configuration_items!inner(display_name,description,billing_period,currency,price_minor,is_visible,offers!inner(offer_code))&offer_configuration_items.is_visible=eq.true',
    );
    return rows.map((row) => this.mapOffer(row));
  }
  async getSelection(selectionId: string): Promise<CheckoutSelection | null> {
    const rows = await this.read<DatabaseOffer[]>(
      `/rest/v1/prices?id=eq.${encodeURIComponent(selectionId)}&provider=eq.stripe&provider_price_id=not.is.null&active_until=is.null&select=id,provider_price_id,offer_configuration_items!inner(display_name,description,billing_period,currency,price_minor,is_visible,offers!inner(offer_code))&offer_configuration_items.is_visible=eq.true&limit=1`,
    );
    const row = rows[0];
    return row
      ? { ...this.mapOffer(row), providerPriceReference: row.provider_price_id }
      : null;
  }
  async getBillingState(profileId: string): Promise<BillingState> {
    return this.write('/rest/v1/rpc/get_billing_state', {
      p_profile_id: profileId,
    });
  }
  async getCustomerReference(profileId: string): Promise<string | null> {
    const rows = await this.read<Array<{ provider_customer_id: string }>>(
      `/rest/v1/stripe_customers?profile_id=eq.${encodeURIComponent(profileId)}&select=provider_customer_id&limit=1`,
    );
    return rows[0]?.provider_customer_id ?? null;
  }
  async recordCheckoutSession(input: {
    profileId: string;
    selectionId: string;
    providerSessionId: string;
    expiresAt: string;
  }): Promise<void> {
    await this.write('/rest/v1/stripe_checkout_sessions', {
      profile_id: input.profileId,
      price_id: input.selectionId,
      provider_session_id: input.providerSessionId,
      status: 'open',
      expires_at: input.expiresAt,
    });
  }
  async applyStripeEvent(
    event: VerifiedStripeEvent,
    rawBody: string,
  ): Promise<{ replayed: boolean }> {
    return this.write('/rest/v1/rpc/apply_verified_stripe_event', {
      p_event_id: event.id,
      p_event_type: event.type,
      p_event_created_at: new Date(event.created * 1_000).toISOString(),
      p_payload: event,
      p_payload_sha256: await this.sha256(rawBody),
    });
  }
  async listActivations(
    profileId: string,
  ): Promise<ActivationRedemptionView[]> {
    const rows = await this.read<
      Array<{
        id: string;
        activated_at: string;
        expires_at: string | null;
        device_id: string | null;
        status: ActivationRedemptionView['status'];
        activation_keys: { key_suffix: string };
      }>
    >(
      `/rest/v1/activation_key_redemptions?profile_id=eq.${encodeURIComponent(profileId)}&select=id,activated_at,expires_at,device_id,status,activation_keys!inner(key_suffix)&order=activated_at.desc`,
    );
    return rows.map((row) => ({
      id: row.id,
      keySuffix: row.activation_keys.key_suffix,
      status:
        row.status === 'active' &&
        row.expires_at &&
        Date.parse(row.expires_at) <= Date.now()
          ? 'expired'
          : row.status,
      activatedAt: row.activated_at,
      expiresAt: row.expires_at,
      deviceId: row.device_id,
    }));
  }
  async redeemActivationKey(input: {
    profileId: string;
    keyHash: string;
    device: ActivateDeviceInput;
  }): Promise<{
    activation: ActivationRedemptionView;
    snapshot: EntitlementSnapshot;
  }> {
    return this.write('/rest/v1/rpc/redeem_activation_key', {
      p_profile_id: input.profileId,
      p_key_hash: input.keyHash,
      p_device_fingerprint_hash: input.device.fingerprintHash,
      p_platform: input.device.platform,
      p_label: input.device.label,
    });
  }
  async revokeActivationKey(input: {
    keyId: string;
    actorProfileId: string;
  }): Promise<void> {
    await this.write('/rest/v1/rpc/revoke_activation_key', {
      p_key_id: input.keyId,
      p_actor_profile_id: input.actorProfileId,
    });
  }

  private mapOffer(row: DatabaseOffer): BillingOfferView {
    const item = row.offer_configuration_items;
    return {
      selectionId: row.id,
      offerCode: item.offers.offer_code,
      displayName: item.display_name,
      description: item.description,
      billingInterval: item.billing_period,
      currency: item.currency,
      unitAmountMinor: item.price_minor,
      testMode: true,
    };
  }
  private async read<T>(path: string): Promise<T> {
    const response = await this.fetcher(
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}${path}`,
      { headers: this.headers() },
    );
    if (!response.ok)
      throw new Error(`Billing database read failed (${response.status}).`);
    return response.json() as Promise<T>;
  }
  private async write<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await this.fetcher(
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}${path}`,
      {
        method: 'POST',
        headers: {
          ...this.headers(),
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error(`Billing database write failed (${response.status}).`);
    const value = (await response.json()) as T | T[];
    return (Array.isArray(value) ? value[0] : value) as T;
  }
  private headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      apikey: this.environment.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${this.environment.SUPABASE_SERVICE_ROLE_KEY}`,
    };
  }
  private async sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
}
