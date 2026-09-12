import { SupabaseJwksTokenVerifier } from './jwt.ts';
import { EcdsaOfflineGrantSigner } from './offlineGrant.ts';
import { DistributedRateLimiter } from './distributedRateLimit.ts';
export { RateLimitBucket } from './distributedRateLimit.ts';
export { StudioRealtimeChannel } from './studioRealtimeChannel.ts';
import { SupabaseRestRepository } from './supabaseRepository.ts';
import type { WorkerEnvironment } from './types.ts';
import { createCommercialWorker } from './worker.ts';
import { SupabaseBillingRepository } from './billing.ts';
import { StripeRestGateway, UnavailableStripeGateway } from './stripe.ts';
import {
  StripeWebhookVerifier,
  UnavailableStripeWebhookVerifier,
} from './stripeWebhook.ts';
import {
  OpenAiResponsesProvider,
  UnavailableAiProvider,
} from './aiProvider.ts';
import { SupabaseAiQuotaRepository } from './aiQuota.ts';
import {
  SupabaseCloudScenarioRepository,
  SupabaseScenarioObjectStorage,
} from './cloudSync.ts';
import { SupabaseStudioRepository } from './studio.ts';
import { CloudflareRealtimeTransport } from './realtimeCollaboration.ts';
import {
  ReconciledRealtimeTransport,
  SupabaseCollaborationLedger,
  SupabaseCollaborationSnapshotPersistence,
} from './collaborationLedger.ts';
import { normalizeHostedSupabaseUrl } from './supabaseAdmin.ts';

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
    const stripeSecretKey = environment.STRIPE_SECRET_KEY?.trim();
    const stripeWebhookSecret = environment.STRIPE_WEBHOOK_SECRET?.trim();
    const stripeConfigured = Boolean(stripeSecretKey && stripeWebhookSecret);
    if (Boolean(stripeSecretKey) !== Boolean(stripeWebhookSecret))
      throw new Error('Incomplete Stripe test configuration.');
    if (stripeSecretKey && !/^sk_test_[A-Za-z0-9_]+$/.test(stripeSecretKey))
      throw new Error('Stripe test key required');

    const openAiApiKey = environment.OPENAI_API_KEY?.trim();
    const openAiShortModel = environment.OPENAI_SHORT_ACTION_MODEL?.trim();
    const openAiPdfModel = environment.OPENAI_PDF_IMPORT_MODEL?.trim();
    const aiConfigured = Boolean(
      openAiApiKey && openAiShortModel && openAiPdfModel,
    );
    if (
      [openAiApiKey, openAiShortModel, openAiPdfModel].filter(Boolean)
        .length !== (aiConfigured ? 3 : 0)
    )
      throw new Error('Incomplete AI test configuration.');
    if (environment.SCENARIO_ENVIRONMENT === 'production') {
      if (!stripeConfigured)
        throw new Error('Stripe test configuration required.');
      if (!aiConfigured) throw new Error('AI provider configuration required.');
    }
    const runtimeEnvironment: WorkerEnvironment = {
      ...environment,
      SUPABASE_URL: normalizeHostedSupabaseUrl(
        required(environment, 'SUPABASE_URL'),
      ),
    };
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
      const cloudRepository = new SupabaseCloudScenarioRepository(
        runtimeEnvironment,
      );
      const scenarioStorage = new SupabaseScenarioObjectStorage(
        runtimeEnvironment,
        environment.CLOUD_STORAGE_BUCKET ?? 'scenario-documents',
      );
      const cloudIdempotencyPepper = required(
        environment,
        'CLOUD_IDEMPOTENCY_PEPPER',
      );
      let realtimeTransport;
      if (environment.STUDIO_REALTIME_CHANNEL) {
        required(environment, 'STUDIO_TICKET_PEPPER');
        realtimeTransport = new ReconciledRealtimeTransport(
          new CloudflareRealtimeTransport(environment.STUDIO_REALTIME_CHANNEL),
          new SupabaseCollaborationLedger(runtimeEnvironment),
          new SupabaseCollaborationSnapshotPersistence(
            runtimeEnvironment,
            cloudRepository,
            scenarioStorage,
            cloudIdempotencyPepper,
          ),
        );
      }
      runtime = createCommercialWorker({
        environment: environment.SCENARIO_ENVIRONMENT,
        allowedOrigins: required(environment, 'API_ALLOWED_ORIGINS')
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
        repository: new SupabaseRestRepository(runtimeEnvironment),
        tokenVerifier: new SupabaseJwksTokenVerifier(
          runtimeEnvironment.SUPABASE_URL,
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
        billingRepository: new SupabaseBillingRepository(runtimeEnvironment),
        stripeGateway: stripeConfigured
          ? new StripeRestGateway(stripeSecretKey!)
          : new UnavailableStripeGateway(),
        stripeWebhookVerifier: stripeConfigured
          ? new StripeWebhookVerifier(
              stripeWebhookSecret!,
              Number(environment.STRIPE_WEBHOOK_TOLERANCE_SECONDS ?? 300),
            )
          : new UnavailableStripeWebhookVerifier(),
        aiProvider: aiConfigured
          ? new OpenAiResponsesProvider({
              apiKey: openAiApiKey!,
              shortActionModel: openAiShortModel!,
              pdfImportModel: openAiPdfModel!,
              timeoutMs: boundedInteger(
                environment.AI_PROVIDER_TIMEOUT_MS,
                90_000,
                1_000,
                300_000,
              ),
            })
          : new UnavailableAiProvider(),
        aiQuotaRepository: new SupabaseAiQuotaRepository(runtimeEnvironment),
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
        cloudRepository,
        scenarioStorage,
        cloudIdempotencyPepper,
        cloudPolicy: {
          maximumBodyBytes: boundedInteger(
            environment.CLOUD_MAX_BODY_BYTES,
            4_194_304,
            65_536,
            8_388_608,
          ),
          downloadTtlSeconds: boundedInteger(
            environment.CLOUD_DOWNLOAD_TTL_SECONDS,
            300,
            30,
            900,
          ),
        },
        studioRepository: new SupabaseStudioRepository(runtimeEnvironment),
        studioInvitationPepper: required(
          environment,
          'STUDIO_INVITATION_PEPPER',
        ),
        studioNotifier: {
          async deliver() {
            throw new Error(
              'External Studio notification provider not configured.',
            );
          },
        },
        studioPolicy: {
          invitationTtlSeconds: boundedInteger(
            environment.STUDIO_INVITATION_TTL_SECONDS,
            86_400,
            900,
            604_800,
          ),
          eventPageSize: boundedInteger(
            environment.STUDIO_EVENT_PAGE_SIZE,
            100,
            1,
            500,
          ),
        },
        realtimeTransport,
      });
      runtimes.set(environment, runtime);
    }
    return runtime.fetch(request);
  },
};

export default productionWorker;
