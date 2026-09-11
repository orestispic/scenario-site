import { SupabaseJwksTokenVerifier } from './jwt.ts';
import { EcdsaOfflineGrantSigner } from './offlineGrant.ts';
import { DistributedRateLimiter } from './distributedRateLimit.ts';
export { RateLimitBucket } from './distributedRateLimit.ts';
import { SupabaseRestRepository } from './supabaseRepository.ts';
import type { WorkerEnvironment } from './types.ts';
import { createCommercialWorker } from './worker.ts';
import { SupabaseBillingRepository } from './billing.ts';
import { StripeRestGateway } from './stripe.ts';
import { StripeWebhookVerifier } from './stripeWebhook.ts';
import { OpenAiResponsesProvider } from './aiProvider.ts';
import { SupabaseAiQuotaRepository } from './aiQuota.ts';

function required(
  environment: WorkerEnvironment,
  key: keyof WorkerEnvironment,
): string {
  const value = environment[key];
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Missing server environment: ${key}`);
  return value;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error('Invalid bounded server configuration');
  return parsed;
}

const runtimes = new WeakMap<
  WorkerEnvironment,
  ReturnType<typeof createCommercialWorker>
>();

const productionWorker = {
  fetch(request: Request, environment: WorkerEnvironment): Promise<Response> {
    if (!['staging', 'production'].includes(environment.SCENARIO_ENVIRONMENT)) {
      throw new Error(
        'The production Worker entry point cannot run the local-test environment.',
      );
    }
    if (
      !/^sk_test_[A-Za-z0-9_]+$/.test(
        required(environment, 'STRIPE_SECRET_KEY'),
      )
    )
      throw new Error('Stripe test key required');
    let runtime = runtimes.get(environment);
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
        rateLimiter: new DistributedRateLimiter(
          environment.RATE_LIMITER,
          required(environment, 'RATE_LIMIT_KEY_PEPPER'),
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
        aiProvider: new OpenAiResponsesProvider({
          apiKey: required(environment, 'OPENAI_API_KEY'),
          shortActionModel: required(environment, 'OPENAI_SHORT_ACTION_MODEL'),
          pdfImportModel: required(environment, 'OPENAI_PDF_IMPORT_MODEL'),
          timeoutMs: boundedInteger(
            environment.AI_PROVIDER_TIMEOUT_MS,
            90_000,
            1_000,
            300_000,
          ),
        }),
        aiQuotaRepository: new SupabaseAiQuotaRepository(environment),
        aiIdempotencyPepper: required(environment, 'AI_IDEMPOTENCY_PEPPER'),
        aiPolicy: {
          shortMaxBodyBytes: boundedInteger(
            environment.AI_SHORT_MAX_BODY_BYTES,
            131_072,
            1_024,
            1_048_576,
          ),
          pdfMaxBodyBytes: boundedInteger(
            environment.AI_PDF_MAX_BODY_BYTES,
            1_048_576,
            8_192,
            4_194_304,
          ),
          maxTranslationSegments: boundedInteger(
            environment.AI_MAX_TRANSLATION_SEGMENTS,
            2_000,
            1,
            10_000,
          ),
          maxResponseBytes: boundedInteger(
            environment.AI_MAX_RESPONSE_BYTES,
            2_097_152,
            1_024,
            4_194_304,
          ),
        },
      });
      runtimes.set(environment, runtime);
    }
    return runtime.fetch(request);
  },
};

export default productionWorker;
