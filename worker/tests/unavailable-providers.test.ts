/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AiProviderError,
  UnavailableAiProvider,
  type AiProvider,
} from '../src/aiProvider.ts';
import {
  UnavailableStripeGateway,
  type StripeGateway,
} from '../src/stripe.ts';
import {
  StripeWebhookError,
  UnavailableStripeWebhookVerifier,
  type StripeWebhookVerifierPort,
} from '../src/stripeWebhook.ts';

describe('fournisseurs externes non configurés', () => {
  it('ferme Stripe sans requête réseau', async () => {
    const gateway: StripeGateway = new UnavailableStripeGateway();
    await assert.rejects(
      gateway.createCheckoutSession({} as never),
      /Stripe test provider is not configured/,
    );

    const verifier: StripeWebhookVerifierPort =
      new UnavailableStripeWebhookVerifier();
    await assert.rejects(
      verifier.verify('{}', null),
      StripeWebhookError,
    );
  });

  it('ferme le fournisseur IA sans requête réseau', async () => {
    const provider: AiProvider = new UnavailableAiProvider();
    await assert.rejects(
      provider.execute({} as never, 'phase9-unavailable-provider'),
      (error: unknown) =>
        error instanceof AiProviderError &&
        error.certainty === 'definitive' &&
        error.code === 'ai_provider_unavailable',
    );
  });
});
