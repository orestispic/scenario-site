import { SupabaseJwksTokenVerifier } from './jwt.ts';
import { EcdsaOfflineGrantSigner } from './offlineGrant.ts';
import { InMemoryRateLimiter } from './rateLimit.ts';
import { SupabaseRestRepository } from './supabaseRepository.ts';
import type { WorkerEnvironment } from './types.ts';
import { createCommercialWorker } from './worker.ts';
import { SupabaseBillingRepository } from './billing.ts';
import { StripeRestGateway } from './stripe.ts';
import { StripeWebhookVerifier } from './stripeWebhook.ts';

function required(
  environment: WorkerEnvironment,
  key: keyof WorkerEnvironment,
): string {
  const value = environment[key];
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Missing server environment: ${key}`);
  return value;
}

let runtime: ReturnType<typeof createCommercialWorker> | null = null;

const productionWorker = {
  fetch(request: Request, environment: WorkerEnvironment): Promise<Response> {
    if (environment.SCENARIO_ENVIRONMENT === 'test') {
      throw new Error(
        'The production Worker entry point cannot run the local-test environment.',
      );
    }
    if (!runtime) {
      const maximumRequests = Number(
        environment.RATE_LIMIT_MAX_REQUESTS ?? 120,
      );
      const windowSeconds = Number(environment.RATE_LIMIT_WINDOW_SECONDS ?? 60);
      const signer = new EcdsaOfflineGrantSigner(
        required(environment, 'OFFLINE_GRANT_KEY_ID'),
        JSON.parse(
          required(environment, 'OFFLINE_GRANT_PRIVATE_JWK'),
        ) as JsonWebKey,
        JSON.parse(
          required(environment, 'OFFLINE_GRANT_PUBLIC_JWK'),
        ) as JsonWebKey,
      );
      const stripeSecretKey = required(environment, 'STRIPE_SECRET_KEY');
      if (!stripeSecretKey.startsWith('sk_test_'))
        throw new Error('Phase 3 accepts Stripe test keys only.');
      runtime = createCommercialWorker({
        environment: environment.SCENARIO_ENVIRONMENT,
        allowedOrigins: required(environment, 'API_ALLOWED_ORIGINS')
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
        repository: new SupabaseRestRepository(environment),
        tokenVerifier: new SupabaseJwksTokenVerifier(
          environment.SUPABASE_URL,
          environment.SUPABASE_JWT_AUDIENCE,
        ),
        offlineGrantSigner: signer,
        rateLimiter: new InMemoryRateLimiter(
          maximumRequests,
          windowSeconds * 1_000,
        ),
        deviceFingerprintPepper: required(
          environment,
          'DEVICE_FINGERPRINT_PEPPER',
        ),
        activationKeyPepper: required(environment, 'ACTIVATION_KEY_PEPPER'),
        billingRepository: new SupabaseBillingRepository(environment),
        stripeGateway: new StripeRestGateway(stripeSecretKey),
        stripeWebhookVerifier: new StripeWebhookVerifier(
          required(environment, 'STRIPE_WEBHOOK_SECRET'),
          Number(environment.STRIPE_WEBHOOK_TOLERANCE_SECONDS ?? 300),
        ),
      });
    }
    return runtime.fetch(request);
  },
};

export default productionWorker;
