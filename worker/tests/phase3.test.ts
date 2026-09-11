/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fingerprintActivationKey } from '../src/activationKeys.ts';
import { LocalBillingRepository } from '../src/localBillingRepository.ts';
import {
  LocalTestRepository,
  LocalTestTokenVerifier,
} from '../src/localTestRepository.ts';
import { createEphemeralOfflineGrantSigner } from '../src/offlineGrant.ts';
import { InMemoryRateLimiter } from '../src/rateLimit.ts';
import { LocalStripeGateway } from '../src/localStripeGateway.ts';
import {
  signStripeFixture,
  StripeWebhookVerifier,
  type VerifiedStripeEvent,
} from '../src/stripeWebhook.ts';
import { createCommercialWorker } from '../src/worker.ts';

const AUTHOR_PROFILE = '10000000-0000-4000-8000-000000000002';
const STUDIO_PROFILE = '10000000-0000-4000-8000-000000000003';
const AUTHOR_MONTH = '30000000-0000-4000-8000-000000000001';
const STUDIO_MONTH = '30000000-0000-4000-8000-000000000003';
const WEBHOOK_SECRET = 'whsec_phase3_fixture';

function subscriptionEvent(input: {
  id: string;
  created: number;
  profileId: string;
  price: string;
  status?: string;
  type?: VerifiedStripeEvent['type'];
  periodStart?: number;
  periodEnd?: number;
}): VerifiedStripeEvent {
  return {
    id: input.id,
    type: input.type ?? 'customer.subscription.updated',
    created: input.created,
    livemode: false,
    data: {
      object: {
        id: `sub_${input.profileId.slice(-4)}`,
        customer: `cus_${input.profileId.slice(-4)}`,
        status: input.status ?? 'active',
        current_period_start: input.periodStart ?? input.created,
        current_period_end: input.periodEnd ?? input.created + 2_592_000,
        cancel_at_period_end: false,
        metadata: { scenario_profile_id: input.profileId },
        items: { data: [{ price: { id: input.price } }] },
      },
    },
  };
}

function invoiceEvent(input: {
  id: string;
  created: number;
  profileId: string;
  paid: boolean;
  price: string;
  periodEnd: number;
}): VerifiedStripeEvent {
  return {
    id: input.id,
    type: input.paid ? 'invoice.paid' : 'invoice.payment_failed',
    created: input.created,
    livemode: false,
    data: {
      object: {
        id: `in_${input.id}`,
        customer: `cus_${input.profileId.slice(-4)}`,
        subscription: `sub_${input.profileId.slice(-4)}`,
        currency: 'eur',
        amount_paid: input.paid ? 1900 : 0,
        period_start: input.created,
        period_end: input.periodEnd,
        scenario_price_id: input.price,
        metadata: { scenario_profile_id: input.profileId },
      },
    },
  };
}

describe('signature Stripe test', () => {
  it('accepte la signature exacte et refuse corps modifié, signature invalide et délai dépassé', async () => {
    const timestamp = 1_800_000_000;
    const raw = JSON.stringify(
      subscriptionEvent({
        id: 'evt_valid',
        created: timestamp,
        profileId: AUTHOR_PROFILE,
        price: 'price_test_author_month',
      }),
    );
    const signature = await signStripeFixture(WEBHOOK_SECRET, raw, timestamp);
    const verifier = new StripeWebhookVerifier(
      WEBHOOK_SECRET,
      300,
      () => timestamp * 1_000,
    );
    await assert.doesNotReject(() => verifier.verify(raw, signature));
    await assert.rejects(
      () => verifier.verify(raw + ' ', signature),
      /Invalid Stripe signature/,
    );
    await assert.rejects(
      () => verifier.verify(raw, signature.replace(/.$/, '0')),
      /Invalid Stripe signature/,
    );
    await assert.rejects(
      () =>
        new StripeWebhookVerifier(
          WEBHOOK_SECRET,
          300,
          () => (timestamp + 301) * 1_000,
        ).verify(raw, signature),
      /outside tolerance/,
    );
  });

  it('ne traite et ne rejoue qu’un webhook vérifié sur le corps brut', async () => {
    const timestamp = Math.floor(Date.now() / 1_000);
    const commercial = new LocalTestRepository();
    const billing = new LocalBillingRepository(commercial);
    const worker = createCommercialWorker({
      environment: 'test',
      allowedOrigins: [],
      repository: commercial,
      tokenVerifier: new LocalTestTokenVerifier(),
      offlineGrantSigner: await createEphemeralOfflineGrantSigner(),
      rateLimiter: new InMemoryRateLimiter(100, 60_000),
      deviceFingerprintPepper: 'device-pepper',
      activationKeyPepper: 'local-test-activation-pepper',
      billingRepository: billing,
      stripeGateway: new LocalStripeGateway(),
      stripeWebhookVerifier: new StripeWebhookVerifier(WEBHOOK_SECRET),
    });
    const raw = JSON.stringify(
      subscriptionEvent({
        id: 'evt_worker',
        created: timestamp,
        profileId: AUTHOR_PROFILE,
        price: 'price_test_author_month',
      }),
    );
    const signature = await signStripeFixture(WEBHOOK_SECRET, raw, timestamp);
    const send = () =>
      worker.fetch(
        new Request('https://api.example.invalid/v2/stripe/webhook', {
          method: 'POST',
          headers: {
            'Stripe-Signature': signature,
            'Content-Type': 'application/json',
          },
          body: raw,
        }),
      );
    const first = await send();
    const second = await send();
    assert.equal(first.status, 200);
    assert.equal(
      ((await first.json()) as { replayed: boolean }).replayed,
      false,
    );
    assert.equal(
      ((await second.json()) as { replayed: boolean }).replayed,
      true,
    );
    assert.equal(
      (await billing.getBillingState(AUTHOR_PROFILE)).status,
      'active',
    );
  });
});

describe('abonnements et droits', () => {
  it('rend les événements idempotents et ignore une projection désynchronisée plus ancienne', async () => {
    const commercial = new LocalTestRepository();
    const billing = new LocalBillingRepository(commercial);
    const newer = subscriptionEvent({
      id: 'evt_new',
      created: 1_900_000_200,
      profileId: AUTHOR_PROFILE,
      price: 'price_test_studio_month',
    });
    const older = subscriptionEvent({
      id: 'evt_old',
      created: 1_900_000_100,
      profileId: AUTHOR_PROFILE,
      price: 'price_test_author_month',
    });
    assert.deepEqual(await billing.applyStripeEvent(newer, '{}'), {
      replayed: false,
    });
    assert.deepEqual(await billing.applyStripeEvent(newer, '{}'), {
      replayed: true,
    });
    await billing.applyStripeEvent(older, '{}');
    assert.equal(
      (await billing.getBillingState(AUTHOR_PROFILE)).offerCode,
      'studio',
    );
    assert.equal(
      (await commercial.getEntitlements(
        AUTHOR_PROFILE,
      ))!.snapshot.entitlements.some(({ code }) => code === 'cloud.sync'),
      true,
    );
  });

  it('couvre changement d’offre, renouvellement, échec, annulation et expiration sans retrait rétroactif', async () => {
    const commercial = new LocalTestRepository();
    const billing = new LocalBillingRepository(commercial);
    await billing.applyStripeEvent(
      subscriptionEvent({
        id: 'evt_author',
        created: 1_900_000_100,
        profileId: AUTHOR_PROFILE,
        price: 'price_test_author_month',
      }),
      '{}',
    );
    await billing.applyStripeEvent(
      subscriptionEvent({
        id: 'evt_studio',
        created: 1_900_000_200,
        profileId: AUTHOR_PROFILE,
        price: 'price_test_studio_month',
      }),
      '{}',
    );
    assert.equal(
      (await billing.getBillingState(AUTHOR_PROFILE)).offerCode,
      'studio',
    );

    await billing.applyStripeEvent(
      invoiceEvent({
        id: 'evt_renew',
        created: 1_900_000_300,
        profileId: AUTHOR_PROFILE,
        paid: true,
        price: 'price_test_studio_month',
        periodEnd: 1_903_000_000,
      }),
      '{}',
    );
    assert.equal(
      (await billing.getBillingState(AUTHOR_PROFILE)).lastPaymentStatus,
      'paid',
    );
    const boughtSnapshot = (await commercial.getEntitlements(AUTHOR_PROFILE))!
      .snapshot.id;
    await billing.applyStripeEvent(
      invoiceEvent({
        id: 'evt_failed',
        created: 1_900_000_400,
        profileId: AUTHOR_PROFILE,
        paid: false,
        price: 'price_test_studio_month',
        periodEnd: 1_903_000_000,
      }),
      '{}',
    );
    assert.equal(
      (await billing.getBillingState(AUTHOR_PROFILE)).status,
      'past_due',
    );
    assert.equal(
      (await commercial.getEntitlements(AUTHOR_PROFILE))!.snapshot.id,
      boughtSnapshot,
    );

    await billing.applyStripeEvent(
      subscriptionEvent({
        id: 'evt_cancel',
        created: 1_900_000_500,
        profileId: AUTHOR_PROFILE,
        price: 'price_test_studio_month',
        type: 'customer.subscription.deleted',
      }),
      '{}',
    );
    assert.equal(
      (await billing.getBillingState(AUTHOR_PROFILE)).status,
      'canceled',
    );
    assert.equal(
      (await commercial.getEntitlements(AUTHOR_PROFILE))!.snapshot.id,
      boughtSnapshot,
    );
    await billing.applyStripeEvent(
      subscriptionEvent({
        id: 'evt_expire',
        created: 1_900_000_600,
        profileId: STUDIO_PROFILE,
        price: 'price_test_studio_month',
        status: 'incomplete',
      }),
      '{}',
    );
    assert.equal(
      (await billing.getBillingState(STUDIO_PROFILE)).status,
      'expired',
    );
  });

  it('n’accorde aucun droit sur le seul retour Checkout et refuse les champs d’élévation', async () => {
    const commercial = new LocalTestRepository();
    const billing = new LocalBillingRepository(commercial);
    await billing.recordCheckoutSession({
      profileId: AUTHOR_PROFILE,
      selectionId: STUDIO_MONTH,
      providerSessionId: 'cs_test_only',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(
      (await commercial.getEntitlements(
        AUTHOR_PROFILE,
      ))!.snapshot.entitlements.some(({ code }) => code === 'cloud.sync'),
      false,
    );

    const worker = createCommercialWorker({
      environment: 'test',
      allowedOrigins: ['http://localhost:3000'],
      repository: commercial,
      tokenVerifier: new LocalTestTokenVerifier(),
      offlineGrantSigner: await createEphemeralOfflineGrantSigner(),
      rateLimiter: new InMemoryRateLimiter(100, 60_000),
      deviceFingerprintPepper: 'device-pepper',
      activationKeyPepper: 'local-test-activation-pepper',
      billingRepository: billing,
      stripeGateway: new LocalStripeGateway(),
      stripeWebhookVerifier: new StripeWebhookVerifier(WEBHOOK_SECRET),
    });
    const response = await worker.fetch(
      new Request('https://api.example.invalid/v2/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer local-test:author',
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selectionId: AUTHOR_MONTH,
          successUrl: 'http://localhost:3000/success',
          cancelUrl: 'http://localhost:3000/cancel',
          role: 'studio',
        }),
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { code: string }).code,
      'unexpected_field',
    );
  });
});

describe('clés d’activation', () => {
  it('active une clé via la route authentifiée sans accepter de droits clients', async () => {
    const commercial = new LocalTestRepository();
    const billing = new LocalBillingRepository(commercial);
    const created = await billing.createLocalActivationKey({
      selectionId: AUTHOR_MONTH,
      maximumActivations: 1,
      expiresAt: null,
    });
    const worker = createCommercialWorker({
      environment: 'test',
      allowedOrigins: ['http://localhost:3000'],
      repository: commercial,
      tokenVerifier: new LocalTestTokenVerifier(),
      offlineGrantSigner: await createEphemeralOfflineGrantSigner(),
      rateLimiter: new InMemoryRateLimiter(100, 60_000),
      deviceFingerprintPepper: 'device-pepper',
      activationKeyPepper: 'local-test-activation-pepper',
      billingRepository: billing,
      stripeGateway: new LocalStripeGateway(),
      stripeWebhookVerifier: new StripeWebhookVerifier(WEBHOOK_SECRET),
    });
    const response = await worker.fetch(
      new Request('https://api.example.invalid/v2/activation-keys/redeem', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer local-test:author',
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key: created.key,
          fingerprint: 'route-device-fingerprint-0001',
          label: 'Portable',
          platform: 'windows',
        }),
      }),
    );
    assert.equal(response.status, 201);
    assert.equal(
      ((await response.json()) as { activation: { status: string } }).activation
        .status,
      'active',
    );
  });

  it('limite et audite aussi les tentatives sans session valide', async () => {
    const commercial = new LocalTestRepository();
    const worker = createCommercialWorker({
      environment: 'test',
      allowedOrigins: [],
      repository: commercial,
      tokenVerifier: new LocalTestTokenVerifier(),
      offlineGrantSigner: await createEphemeralOfflineGrantSigner(),
      rateLimiter: new InMemoryRateLimiter(1, 60_000),
      deviceFingerprintPepper: 'device-pepper',
      activationKeyPepper: 'local-test-activation-pepper',
      billingRepository: new LocalBillingRepository(commercial),
      stripeGateway: new LocalStripeGateway(),
      stripeWebhookVerifier: new StripeWebhookVerifier(WEBHOOK_SECRET),
    });
    const request = () =>
      worker.fetch(
        new Request('https://api.example.invalid/v2/activation-keys/redeem', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer invalid',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            key: 'SCN-INVALID',
            fingerprint: 'invalid-session-device-0001',
            label: 'PC',
            platform: 'windows',
          }),
        }),
      );
    assert.equal((await request()).status, 401);
    assert.equal((await request()).status, 429);
    assert.equal(
      commercial.audit.filter(
        ({ action }) => action === 'activation_key.redeem_failed',
      ).length,
      2,
    );
  });

  it('génère une clé à forte entropie, ne conserve que son empreinte et applique validité, révocation et maximum', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const commercial = new LocalTestRepository();
    const billing = new LocalBillingRepository(
      commercial,
      'local-test-activation-pepper',
      () => now,
    );
    const created = await billing.createLocalActivationKey({
      selectionId: AUTHOR_MONTH,
      maximumActivations: 1,
      expiresAt: '2026-02-01T00:00:00Z',
    });
    assert.match(created.key, /^SCN-(?:[A-Z2-9]{6}-){6}[A-Z2-9]{3,6}$/);
    const hash = await fingerprintActivationKey(
      created.key,
      'local-test-activation-pepper',
    );
    await assert.rejects(
      () =>
        billing.redeemActivationKey({
          profileId: AUTHOR_PROFILE,
          keyHash: '0'.repeat(64),
          device: {
            fingerprintHash: 'a'.repeat(64),
            label: 'PC',
            platform: 'windows',
          },
        }),
      /invalide/,
    );
    const redeemed = await billing.redeemActivationKey({
      profileId: AUTHOR_PROFILE,
      keyHash: hash,
      device: {
        fingerprintHash: 'a'.repeat(64),
        label: 'PC',
        platform: 'windows',
      },
    });
    assert.equal(redeemed.activation.keySuffix, created.keySuffix);
    await assert.rejects(
      () =>
        billing.redeemActivationKey({
          profileId: STUDIO_PROFILE,
          keyHash: hash,
          device: {
            fingerprintHash: 'b'.repeat(64),
            label: 'Mac',
            platform: 'macos',
          },
        }),
      /maximal/,
    );
    await billing.revokeActivationKey({
      keyId: created.id,
      actorProfileId: 'local-admin',
    });
    assert.equal(
      (await billing.listActivations(AUTHOR_PROFILE))[0].status,
      'revoked',
    );

    const expiring = await billing.createLocalActivationKey({
      selectionId: AUTHOR_MONTH,
      maximumActivations: 2,
      expiresAt: '2026-01-02T00:00:00Z',
    });
    now = Date.parse('2026-01-03T00:00:00Z');
    const expiredHash = await fingerprintActivationKey(
      expiring.key,
      'local-test-activation-pepper',
    );
    await assert.rejects(
      () =>
        billing.redeemActivationKey({
          profileId: STUDIO_PROFILE,
          keyHash: expiredHash,
          device: {
            fingerprintHash: 'c'.repeat(64),
            label: 'PC',
            platform: 'windows',
          },
        }),
      /expirée/,
    );
  });

  it('applique la limite d’appareils du snapshot serveur', async () => {
    const commercial = new LocalTestRepository();
    const billing = new LocalBillingRepository(commercial);
    for (let index = 0; index < 3; index += 1) {
      const created = await billing.createLocalActivationKey({
        selectionId: AUTHOR_MONTH,
        maximumActivations: 1,
        expiresAt: null,
      });
      const hash = await fingerprintActivationKey(
        created.key,
        'local-test-activation-pepper',
      );
      const action = billing.redeemActivationKey({
        profileId: AUTHOR_PROFILE,
        keyHash: hash,
        device: {
          fingerprintHash: String(index).repeat(64),
          label: `PC ${index}`,
          platform: 'windows',
        },
      });
      if (index < 2) await assert.doesNotReject(() => action);
      else await assert.rejects(() => action, /appareils/);
    }
  });
});
