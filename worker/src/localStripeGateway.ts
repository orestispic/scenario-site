import type {
  StripeCheckoutInput,
  StripeCheckoutResult,
  StripeGateway,
} from './stripe.ts';

export class LocalStripeGateway implements StripeGateway {
  constructor(private readonly browserOrigin = 'http://localhost:3000') {}

  async createCheckoutSession(
    _input: StripeCheckoutInput,
  ): Promise<StripeCheckoutResult> {
    const id = `cs_test_${crypto.randomUUID().replaceAll('-', '')}`;
    return {
      id,
      url: `${this.browserOrigin}/?checkout=simulated&session_id=${encodeURIComponent(id)}`,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }

  async createPortalSession(): Promise<{ url: string }> {
    return { url: `${this.browserOrigin}/?portal=simulated` };
  }
}
