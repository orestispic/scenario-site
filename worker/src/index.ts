import { SupabaseJwksTokenVerifier } from './jwt.ts';
import { createActiveSessionCheck } from './activeSession.ts';
import { EcdsaOfflineGrantSigner } from './offlineGrant.ts';
import { DistributedRateLimiter } from './distributedRateLimit.ts';
import { SupabaseProjectMetadataRepository } from './projectMetadata.ts';
import { SupabaseProjectBranchRepository } from './projectBranches.ts';
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
import { OpenAiResponsesProvider } from './aiProvider.ts';
import { SupabaseTokenRepository } from './aiTokens.ts';
import {
  SupabaseCloudScenarioRepository,
  SupabaseScenarioObjectStorage,
} from './cloudSync.ts';
import { SupabaseStudioRepository } from './studio.ts';
import { SupabaseCloudProjectRepository } from './cloudProjects.ts';
import { CloudflareRealtimeTransport } from './realtimeCollaboration.ts';
import {
  ReconciledRealtimeTransport,
  SupabaseCollaborationLedger,
  SupabaseCollaborationSnapshotPersistence,
} from './collaborationLedger.ts';
import { normalizeHostedSupabaseUrl } from './supabaseAdmin.ts';
import { SupabaseContactRepository } from './contacts.ts';

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
    const aiConfigured = Boolean(openAiApiKey);
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
      const previousOfflineKeys = Object.fromEntries(Object.entries(
        environment.OFFLINE_GRANT_PREVIOUS_PUBLIC_JWKS
          ? JSON.parse(environment.OFFLINE_GRANT_PREVIOUS_PUBLIC_JWKS) as Record<string, JsonWebKey>
          : {},
      ).map(([keyId, jwk]) => [keyId, { ...jwk, d: undefined }]));
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
      const metadataRepository = new SupabaseProjectMetadataRepository(runtimeEnvironment, cloudRepository, scenarioStorage);
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
            fetch,
            metadataRepository,
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
          fetch,
          Date.now,
          createActiveSessionCheck(runtimeEnvironment),
        ),
        offlineGrantSigner: signer,
        offlineGrantVerificationKeys: previousOfflineKeys,
        rateLimiter: new DistributedRateLimiter(
          environment.RATE_LIMITER,
          required(environment, 'RATE_LIMIT_KEY_PEPPER'),
          maximumRequests,
          windowSeconds * 1_000,
        ),
        ingressRateLimiter: new DistributedRateLimiter(
          environment.RATE_LIMITER,
          required(environment, 'RATE_LIMIT_KEY_PEPPER'),
          Number(environment.RATE_LIMIT_INGRESS_MAX_REQUESTS ?? 1200),
          windowSeconds * 1_000,
        ),
        projectRepository: new SupabaseCloudProjectRepository(runtimeEnvironment),
        contactRepository: new SupabaseContactRepository(runtimeEnvironment),
        branchRepository: new SupabaseProjectBranchRepository(runtimeEnvironment, scenarioStorage),
        metadataRepository,
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
        aiTokens: {
          repository: new SupabaseTokenRepository(runtimeEnvironment),
          provider: aiConfigured ? new OpenAiResponsesProvider({
            apiKey: openAiApiKey!,
            timeoutMs: boundedInteger(environment.AI_PROVIDER_TIMEOUT_MS, 90_000, 1_000, 300_000),
          }) : undefined,
        },
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
