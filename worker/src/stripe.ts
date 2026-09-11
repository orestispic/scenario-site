export interface StripeCheckoutInput {
  priceReference: string;
  profileId: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface StripeCheckoutResult {
  id: string;
  url: string;
  expiresAt: string;
}

export interface StripeGateway {
  createCheckoutSession(
    input: StripeCheckoutInput,
  ): Promise<StripeCheckoutResult>;
  createPortalSession(input: {
    customerReference: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string }>;
}

function stripeForm(values: Record<string, string>): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form.toString();
}

export class StripeRestGateway implements StripeGateway {
  constructor(
    private readonly secretKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async createCheckoutSession(
    input: StripeCheckoutInput,
  ): Promise<StripeCheckoutResult> {
    const response = await this.request(
      '/v1/checkout/sessions',
      input.idempotencyKey,
      {
        mode: 'subscription',
        'line_items[0][price]': input.priceReference,
        'line_items[0][quantity]': '1',
        customer_email: input.customerEmail,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        'metadata[scenario_profile_id]': input.profileId,
        'subscription_data[metadata][scenario_profile_id]': input.profileId,
      },
    );
    const body = (await response.json()) as {
      id?: string;
      url?: string;
      expires_at?: number;
    };
    if (!body.id || !body.url || !body.expires_at)
      throw new Error('Stripe returned an incomplete Checkout Session.');
    return {
      id: body.id,
      url: body.url,
      expiresAt: new Date(body.expires_at * 1_000).toISOString(),
    };
  }

  async createPortalSession(input: {
    customerReference: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string }> {
    const response = await this.request(
      '/v1/billing_portal/sessions',
      input.idempotencyKey,
      {
        customer: input.customerReference,
        return_url: input.returnUrl,
      },
    );
    const body = (await response.json()) as { url?: string };
    if (!body.url)
      throw new Error('Stripe returned an incomplete Portal Session.');
    return { url: body.url };
  }

  private async request(
    path: string,
    idempotencyKey: string,
    values: Record<string, string>,
  ): Promise<Response> {
    const response = await this.fetcher(`https://api.stripe.com${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey,
      },
      body: stripeForm(values),
    });
    if (!response.ok)
      throw new Error(`Stripe request failed (${response.status}).`);
    return response;
  }
}
