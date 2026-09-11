export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface VerifiedStripeEvent {
  id: string;
  type:
    | 'checkout.session.completed'
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted'
    | 'invoice.paid'
    | 'invoice.payment_failed';
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

export class StripeWebhookError extends Error {}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function signStripeFixture(
  secret: string,
  rawBody: string,
  timestamp: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  return `t=${timestamp},v1=${toHex(signature)}`;
}

export class StripeWebhookVerifier {
  constructor(
    private readonly secret: string,
    private readonly toleranceSeconds = STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !secret ||
      !Number.isSafeInteger(toleranceSeconds) ||
      toleranceSeconds < 1 ||
      toleranceSeconds > 300
    )
      throw new Error('Invalid Stripe webhook configuration');
  }

  async verify(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<VerifiedStripeEvent> {
    if (!signatureHeader)
      throw new StripeWebhookError('Missing Stripe signature.');
    const parts = signatureHeader.split(',');
    const timestamp = Number(
      parts.find((part) => part.startsWith('t='))?.slice(2),
    );
    const signatures = parts
      .filter((part) => part.startsWith('v1='))
      .map((part) => part.slice(3));
    if (!Number.isSafeInteger(timestamp) || signatures.length === 0)
      throw new StripeWebhookError('Malformed Stripe signature.');
    if (
      Math.abs(Math.floor(this.now() / 1_000) - timestamp) >
      this.toleranceSeconds
    )
      throw new StripeWebhookError(
        'Stripe signature timestamp is outside tolerance.',
      );

    const expected = (
      await signStripeFixture(this.secret, rawBody, timestamp)
    ).slice(`t=${timestamp},v1=`.length);
    if (!signatures.some((signature) => timingSafeEqual(signature, expected)))
      throw new StripeWebhookError('Invalid Stripe signature.');

    let value: unknown;
    try {
      value = JSON.parse(rawBody);
    } catch {
      throw new StripeWebhookError('Invalid Stripe payload.');
    }
    if (!value || typeof value !== 'object')
      throw new StripeWebhookError('Invalid Stripe event.');
    const event = value as Partial<VerifiedStripeEvent>;
    const supported = new Set<VerifiedStripeEvent['type']>([
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
    ]);
    if (
      typeof event.id !== 'string' ||
      !supported.has(event.type as VerifiedStripeEvent['type']) ||
      !Number.isSafeInteger(event.created) ||
      event.livemode !== false ||
      !event.data ||
      typeof event.data.object !== 'object'
    ) {
      throw new StripeWebhookError(
        'Unsupported or malformed Stripe test event.',
      );
    }
    return event as VerifiedStripeEvent;
  }
}
