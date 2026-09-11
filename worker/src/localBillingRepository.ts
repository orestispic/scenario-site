import type {
  ActivationRedemptionView,
  BillingOfferView,
  BillingState,
  LocalActivationKeyCreation,
} from '../../lib/commercial/contracts-v3.ts';
import type { EntitlementSnapshot } from '../../lib/commercial/contracts.ts';
import {
  activationKeySuffix,
  fingerprintActivationKey,
  generateActivationKey,
} from './activationKeys.ts';
import type { BillingRepository, CheckoutSelection } from './billing.ts';
import type { LocalTestRepository } from './localTestRepository.ts';
import type { VerifiedStripeEvent } from './stripeWebhook.ts';
import {
  CommercialRepositoryError,
  type ActivateDeviceInput,
} from './types.ts';

type LocalCatalogItem = CheckoutSelection & {
  configurationVersion: string;
  deviceLimit: number;
  offlineGraceDays: number;
  entitlements: EntitlementSnapshot['entitlements'];
  quotaLimits: Record<string, number>;
  quotaPeriods: Record<string, 'month' | 'lifetime'>;
};

const LOCAL_CATALOG: LocalCatalogItem[] = [
  {
    selectionId: '30000000-0000-4000-8000-000000000001',
    providerPriceReference: 'price_test_author_month',
    offerCode: 'author_ai',
    displayName: 'Auteur IA',
    description: 'Écriture augmentée pour un auteur.',
    billingInterval: 'month',
    currency: 'EUR',
    unitAmountMinor: 1900,
    testMode: true,
    configurationVersion: 'local-billing-v1',
    deviceLimit: 2,
    offlineGraceDays: 7,
    entitlements: [
      { code: 'local.edit', enabled: true, value: null },
      { code: 'ai.actions', enabled: true, value: null },
      { code: 'ai_short_action', enabled: true, value: null },
      { code: 'ai_pdf_import', enabled: true, value: null },
    ],
    quotaLimits: { ai_short_action: 6, ai_pdf_import: 2 },
    quotaPeriods: { ai_short_action: 'month', ai_pdf_import: 'month' },
  },
  {
    selectionId: '30000000-0000-4000-8000-000000000002',
    providerPriceReference: 'price_test_author_year',
    offerCode: 'author_ai',
    displayName: 'Auteur IA',
    description: 'Écriture augmentée pour un auteur.',
    billingInterval: 'year',
    currency: 'EUR',
    unitAmountMinor: 19000,
    testMode: true,
    configurationVersion: 'local-billing-v1',
    deviceLimit: 2,
    offlineGraceDays: 7,
    entitlements: [
      { code: 'local.edit', enabled: true, value: null },
      { code: 'ai.actions', enabled: true, value: null },
      { code: 'ai_short_action', enabled: true, value: null },
      { code: 'ai_pdf_import', enabled: true, value: null },
    ],
    quotaLimits: { ai_short_action: 6, ai_pdf_import: 2 },
    quotaPeriods: { ai_short_action: 'month', ai_pdf_import: 'month' },
  },
  {
    selectionId: '30000000-0000-4000-8000-000000000003',
    providerPriceReference: 'price_test_studio_month',
    offerCode: 'studio',
    displayName: 'Studio',
    description: 'Collaboration et synchronisation pour une équipe.',
    billingInterval: 'month',
    currency: 'EUR',
    unitAmountMinor: 4900,
    testMode: true,
    configurationVersion: 'local-billing-v1',
    deviceLimit: 3,
    offlineGraceDays: 7,
    entitlements: [
      { code: 'local.edit', enabled: true, value: null },
      { code: 'ai.actions', enabled: true, value: null },
      { code: 'ai_short_action', enabled: true, value: null },
      { code: 'ai_pdf_import', enabled: true, value: null },
      { code: 'cloud.sync', enabled: true, value: null },
    ],
    quotaLimits: { ai_short_action: 10, ai_pdf_import: 4 },
    quotaPeriods: { ai_short_action: 'month', ai_pdf_import: 'month' },
  },
  {
    selectionId: '30000000-0000-4000-8000-000000000004',
    providerPriceReference: 'price_test_studio_year',
    offerCode: 'studio',
    displayName: 'Studio',
    description: 'Collaboration et synchronisation pour une équipe.',
    billingInterval: 'year',
    currency: 'EUR',
    unitAmountMinor: 49000,
    testMode: true,
    configurationVersion: 'local-billing-v1',
    deviceLimit: 3,
    offlineGraceDays: 7,
    entitlements: [
      { code: 'local.edit', enabled: true, value: null },
      { code: 'ai.actions', enabled: true, value: null },
      { code: 'ai_short_action', enabled: true, value: null },
      { code: 'ai_pdf_import', enabled: true, value: null },
      { code: 'cloud.sync', enabled: true, value: null },
    ],
    quotaLimits: { ai_short_action: 10, ai_pdf_import: 4 },
    quotaPeriods: { ai_short_action: 'month', ai_pdf_import: 'month' },
  },
];

type LocalKeyRecord = {
  id: string;
  hash: string;
  suffix: string;
  selection: LocalCatalogItem;
  maximumActivations: number;
  activationCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
};

const emptyBilling = (): BillingState => ({
  status: 'none',
  offerCode: null,
  offerDisplayName: null,
  billingInterval: null,
  currentPeriodStartsAt: null,
  currentPeriodEndsAt: null,
  cancelAtPeriodEnd: false,
  lastPaymentStatus: null,
  source: null,
  testMode: true,
});
const stringField = (
  object: Record<string, unknown>,
  key: string,
): string | null =>
  typeof object[key] === 'string' ? (object[key] as string) : null;
const numberDate = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1_000).toISOString()
    : null;

function subscriptionPriceReference(
  object: Record<string, unknown>,
): string | null {
  const items = object.items as
    | { data?: Array<{ price?: { id?: unknown } }> }
    | undefined;
  const value = items?.data?.[0]?.price?.id;
  return typeof value === 'string' ? value : null;
}

export class LocalBillingRepository implements BillingRepository {
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private keySnapshots = new Map<
    string,
    Array<{ profileId: string; snapshotId: string }>
  >();
  private readonly processedEvents = new Map<string, string>();
  private readonly billing = new Map<string, BillingState>();
  private readonly customerProfiles = new Map<string, string>();
  private readonly checkoutProfiles = new Map<
    string,
    { profileId: string; selectionId: string }
  >();
  private readonly lastEventCreated = new Map<string, number>();
  private readonly keys = new Map<string, LocalKeyRecord>();
  private readonly activations = new Map<string, ActivationRedemptionView[]>();

  constructor(
    private readonly commercial: LocalTestRepository,
    private readonly keyPepper = 'local-test-activation-pepper',
    private readonly now: () => number = Date.now,
  ) {}

  async listOffers(): Promise<BillingOfferView[]> {
    return LOCAL_CATALOG.map(
      ({
        providerPriceReference: _provider,
        configurationVersion: _version,
        deviceLimit: _limit,
        offlineGraceDays: _grace,
        entitlements: _rights,
        quotaLimits: _quotas,
        quotaPeriods: _periods,
        ...offer
      }) => structuredClone(offer),
    );
  }

  async getSelection(selectionId: string): Promise<CheckoutSelection | null> {
    return structuredClone(
      LOCAL_CATALOG.find((item) => item.selectionId === selectionId) ?? null,
    );
  }
  async getBillingState(profileId: string): Promise<BillingState> {
    return structuredClone(this.billing.get(profileId) ?? emptyBilling());
  }
  async getCustomerReference(profileId: string): Promise<string | null> {
    return (
      [...this.customerProfiles].find(
        ([, value]) => value === profileId,
      )?.[0] ?? null
    );
  }
  async recordCheckoutSession(input: {
    profileId: string;
    selectionId: string;
    providerSessionId: string;
    expiresAt: string;
  }): Promise<void> {
    this.checkoutProfiles.set(input.providerSessionId, {
      profileId: input.profileId,
      selectionId: input.selectionId,
    });
  }

  async applyStripeEvent(
    event: VerifiedStripeEvent,
    _rawBody: string,
  ): Promise<{ replayed: boolean }> {
    if (this.processedEvents.has(event.id)) {
      if (this.processedEvents.get(event.id) !== _rawBody)
        throw new CommercialRepositoryError(
          409,
          'event_payload_mismatch',
          'Événement incohérent.',
        );
      return { replayed: true };
    }
    const object = event.data.object;
    if (event.type === 'checkout.session.completed') {
      const checkout = this.checkoutProfiles.get(
        stringField(object, 'id') ?? '',
      );
      const customer = stringField(object, 'customer');
      if (!checkout || !customer)
        throw new CommercialRepositoryError(
          422,
          'checkout_profile_missing',
          'Session Checkout inconnue.',
        );
      this.customerProfiles.set(customer, checkout.profileId);
      this.processedEvents.set(event.id, _rawBody);
      return { replayed: false };
    }
    const customer = stringField(object, 'customer');
    const metadata = object.metadata as Record<string, unknown> | undefined;
    const profileId =
      (customer && this.customerProfiles.get(customer)) ||
      (typeof metadata?.scenario_profile_id === 'string'
        ? metadata.scenario_profile_id
        : null);
    if (!profileId)
      throw new CommercialRepositoryError(
        422,
        'stripe_profile_missing',
        'Événement Stripe sans profil Scénario.',
      );
    if (customer) this.customerProfiles.set(customer, profileId);
    const previousCreated = this.lastEventCreated.get(profileId) ?? -1;
    if (event.created < previousCreated) {
      this.processedEvents.set(event.id, _rawBody);
      return { replayed: false };
    }
    this.lastEventCreated.set(profileId, event.created);
    const current = this.billing.get(profileId) ?? emptyBilling();
    if (event.type.startsWith('customer.subscription.')) {
      const selection = LOCAL_CATALOG.find(
        (item) =>
          item.providerPriceReference === subscriptionPriceReference(object),
      );
      const status =
        event.type === 'customer.subscription.deleted'
          ? 'canceled'
          : stringField(object, 'status');
      const next: BillingState = {
        ...current,
        status:
          status === 'trialing' ||
          status === 'active' ||
          status === 'past_due' ||
          status === 'paused' ||
          status === 'canceled'
            ? status
            : 'expired',
        offerCode: selection?.offerCode ?? current.offerCode,
        offerDisplayName: selection?.displayName ?? current.offerDisplayName,
        billingInterval: selection?.billingInterval ?? current.billingInterval,
        currentPeriodStartsAt:
          numberDate(object.current_period_start) ??
          current.currentPeriodStartsAt,
        currentPeriodEndsAt:
          numberDate(object.current_period_end) ?? current.currentPeriodEndsAt,
        cancelAtPeriodEnd: object.cancel_at_period_end === true,
        source: 'stripe',
      };
      this.billing.set(profileId, next);
      if (selection && (next.status === 'active' || next.status === 'trialing'))
        this.issueGrant(
          profileId,
          selection,
          next.currentPeriodStartsAt,
          next.currentPeriodEndsAt,
        );
      this.processedEvents.set(event.id, _rawBody);
      return { replayed: false };
    }
    const paid = event.type === 'invoice.paid';
    const subscription = object.subscription_details as
      | { metadata?: Record<string, unknown> }
      | undefined;
    const priceReference =
      stringField(object, 'scenario_price_id') ??
      (typeof subscription?.metadata?.scenario_price_id === 'string'
        ? subscription.metadata.scenario_price_id
        : null);
    const selection =
      LOCAL_CATALOG.find(
        (item) => item.providerPriceReference === priceReference,
      ) ??
      LOCAL_CATALOG.find(
        (item) =>
          item.offerCode === current.offerCode &&
          item.billingInterval === current.billingInterval,
      );
    const periodStart =
      numberDate(object.period_start) ?? current.currentPeriodStartsAt;
    const periodEnd =
      numberDate(object.period_end) ?? current.currentPeriodEndsAt;
    this.billing.set(profileId, {
      ...current,
      status: paid ? 'active' : 'past_due',
      lastPaymentStatus: paid ? 'paid' : 'failed',
      currentPeriodStartsAt: periodStart,
      currentPeriodEndsAt: periodEnd,
      source: 'stripe',
    });
    if (paid && selection)
      this.issueGrant(profileId, selection, periodStart, periodEnd);
    this.processedEvents.set(event.id, _rawBody);
    return { replayed: false };
  }

  async listActivations(
    profileId: string,
  ): Promise<ActivationRedemptionView[]> {
    return structuredClone(
      (this.activations.get(profileId) ?? []).map((activation) =>
        activation.status === 'active' &&
        activation.expiresAt &&
        Date.parse(activation.expiresAt) <= this.now()
          ? { ...activation, status: 'expired' as const }
          : activation,
      ),
    );
  }

  redeemActivationKey(input: {
    profileId: string;
    keyHash: string;
    device: ActivateDeviceInput;
  }) {
    const result = this.mutationQueue.then(() => this.redeemSerial(input));
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  private async redeemSerial(input: {
    profileId: string;
    keyHash: string;
    device: ActivateDeviceInput;
  }): Promise<{
    activation: ActivationRedemptionView;
    snapshot: EntitlementSnapshot;
  }> {
    const record = [...this.keys.values()].find(
      (candidate) => candidate.hash === input.keyHash,
    );
    if (!record)
      throw new CommercialRepositoryError(
        404,
        'activation_key_invalid',
        'Clé d’activation invalide.',
      );
    if (record.revokedAt)
      throw new CommercialRepositoryError(
        409,
        'activation_key_revoked',
        'Clé d’activation révoquée.',
      );
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now())
      throw new CommercialRepositoryError(
        409,
        'activation_key_expired',
        'Clé d’activation expirée.',
      );
    if (record.activationCount >= record.maximumActivations)
      throw new CommercialRepositoryError(
        409,
        'activation_limit_reached',
        'Nombre maximal d’activations atteint.',
      );
    if (
      (this.activations.get(input.profileId) ?? []).some(
        (activation) =>
          activation.id === record.id && activation.status === 'active',
      )
    )
      throw new CommercialRepositoryError(
        409,
        'activation_already_used',
        'Clé déjà activée pour ce compte.',
      );
    const device = await this.commercial.activateDevice(
      input.profileId,
      input.device,
      record.selection.deviceLimit,
    );
    const snapshot = this.issueGrant(
      input.profileId,
      record.selection,
      new Date(this.now()).toISOString(),
      record.expiresAt,
    );
    this.keySnapshots.set(record.id, [
      ...(this.keySnapshots.get(record.id) ?? []),
      { profileId: input.profileId, snapshotId: snapshot.id },
    ]);
    const activation: ActivationRedemptionView = {
      id: record.id,
      keySuffix: record.suffix,
      status: 'active',
      activatedAt: new Date(this.now()).toISOString(),
      expiresAt: record.expiresAt,
      deviceId: device.id,
    };
    record.activationCount += 1;
    this.activations.set(input.profileId, [
      ...(this.activations.get(input.profileId) ?? []),
      activation,
    ]);
    this.billing.set(input.profileId, {
      ...emptyBilling(),
      status: 'active',
      offerCode: record.selection.offerCode,
      offerDisplayName: record.selection.displayName,
      billingInterval: record.selection.billingInterval,
      currentPeriodStartsAt: activation.activatedAt,
      currentPeriodEndsAt: record.expiresAt,
      source: 'activation_key',
    });
    return { activation: structuredClone(activation), snapshot };
  }

  async revokeActivationKey(input: {
    keyId: string;
    actorProfileId: string;
  }): Promise<void> {
    await this.mutationQueue;
    const record = this.keys.get(input.keyId);
    if (!record)
      throw new CommercialRepositoryError(
        404,
        'activation_key_missing',
        'Clé introuvable.',
      );
    record.revokedAt = new Date(this.now()).toISOString();
    for (const grant of this.keySnapshots.get(record.id) ?? []) {
      this.commercial.revokeGrant(grant.profileId, grant.snapshotId);
      if (this.billing.get(grant.profileId)?.source === 'activation_key')
        this.billing.set(grant.profileId, emptyBilling());
    }
    for (const values of this.activations.values())
      for (const activation of values)
        if (activation.id === input.keyId) activation.status = 'revoked';
  }

  async createLocalActivationKey(input: {
    selectionId: string;
    maximumActivations: number;
    expiresAt: string | null;
  }): Promise<LocalActivationKeyCreation> {
    const selection = LOCAL_CATALOG.find(
      (item) => item.selectionId === input.selectionId,
    );
    if (!selection)
      throw new CommercialRepositoryError(
        400,
        'selection_invalid',
        'Offre locale inconnue.',
      );
    if (
      !Number.isInteger(input.maximumActivations) ||
      input.maximumActivations < 1 ||
      input.maximumActivations > 100
    )
      throw new CommercialRepositoryError(
        400,
        'activation_limit_invalid',
        'Limite d’activations invalide.',
      );
    if (
      input.expiresAt &&
      (!Number.isFinite(Date.parse(input.expiresAt)) ||
        Date.parse(input.expiresAt) <= this.now())
    )
      throw new CommercialRepositoryError(
        400,
        'activation_expiry_invalid',
        'Expiration invalide.',
      );
    const key = generateActivationKey();
    const id = crypto.randomUUID();
    const record: LocalKeyRecord = {
      id,
      hash: await fingerprintActivationKey(key, this.keyPepper),
      suffix: activationKeySuffix(key),
      selection,
      maximumActivations: input.maximumActivations,
      activationCount: 0,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.keys.set(id, record);
    return {
      id,
      key,
      keySuffix: record.suffix,
      expiresAt: record.expiresAt,
      maximumActivations: record.maximumActivations,
    };
  }

  private issueGrant(
    profileId: string,
    selection: LocalCatalogItem,
    startsAt: string | null,
    endsAt: string | null,
  ): EntitlementSnapshot {
    const issuedAt = startsAt ?? new Date(this.now()).toISOString();
    const offlineValidUntil = new Date(
      Math.min(
        endsAt ? Date.parse(endsAt) : Number.POSITIVE_INFINITY,
        Date.parse(issuedAt) + selection.offlineGraceDays * 86_400_000,
      ),
    ).toISOString();
    return this.commercial.grantEntitlements(profileId, {
      configurationVersion: selection.configurationVersion,
      issuedAt,
      expiresAt: endsAt,
      offlineValidUntil,
      deviceLimit: selection.deviceLimit,
      entitlements: selection.entitlements,
      quotaLimits: selection.quotaLimits,
      quotaPeriods: selection.quotaPeriods,
    });
  }
}
