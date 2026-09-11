import {
  LocalTestRepository,
  LocalTestTokenVerifier,
} from './localTestRepository.ts';
import { LocalAuthService } from './localAuthService.ts';
import { LocalBillingRepository } from './localBillingRepository.ts';
import { LocalStripeGateway } from './localStripeGateway.ts';
import { InMemoryRateLimiter } from './rateLimit.ts';
import { createEphemeralOfflineGrantSigner } from './offlineGrant.ts';
import { StripeWebhookVerifier } from './stripeWebhook.ts';
import { createCommercialWorker } from './worker.ts';
import type { WorkerDependencies } from './types.ts';
import { DeterministicLocalAiProvider } from './localAiProvider.ts';
import { LocalAiQuotaRepository } from './localAiQuotaRepository.ts';
import {
  LocalCloudScenarioRepository,
  LocalScenarioObjectStorage,
} from './cloudSync.ts';
import {
  DeterministicLocalStudioNotifier,
  LocalStudioRepository,
} from './studio.ts';
import { DeterministicLocalRealtimeTransport } from './realtimeCollaboration.ts';

export async function createLocalRuntime(
  overrides: Partial<WorkerDependencies> = {},
  now = Date.now,
) {
  const repository = new LocalTestRepository();
  const auth = new LocalAuthService(repository, now);
  repository.logout = (token?: string) => auth.logout(token ?? '');
  const billing = new LocalBillingRepository(repository);
  const selector = new LocalTestTokenVerifier();
  const cloudRepository = new LocalCloudScenarioRepository(repository, now);
  const scenarioStorage = new LocalScenarioObjectStorage(now);
  const studioNotifier = new DeterministicLocalStudioNotifier();
  const studioRepository = new LocalStudioRepository(
    repository,
    cloudRepository,
    now,
  );
  const realtimeTransport = new DeterministicLocalRealtimeTransport(
    studioRepository,
    'ephemeral-local-realtime-ticket-pepper',
    {
      ticketTtlSeconds: 30,
      heartbeatIntervalSeconds: 10,
      idleTimeoutSeconds: 30,
      maximumConnectionSeconds: 3_600,
      maximumConnectionsPerStudio: 32,
      maximumConnectionsPerProfile: 3,
      maximumOperationBytes: 65_536,
      maximumPendingEvents: 500,
      maximumEventsPerPoll: 100,
      reconnectBackoffMaximumSeconds: 30,
      tombstoneRetentionOperations: 100,
    },
    now,
  );
  const worker = createCommercialWorker({
    environment: 'test',
    allowedOrigins: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:1420',
      'http://127.0.0.1:1420',
    ],
    repository,
    tokenVerifier: {
      verify: (header) =>
        header?.startsWith('Bearer local-test:')
          ? selector.verify(header)
          : auth.verify(header),
    },
    offlineGrantSigner: await createEphemeralOfflineGrantSigner(),
    rateLimiter: new InMemoryRateLimiter(300, 60_000),
    deviceFingerprintPepper: 'ephemeral-local-test-pepper',
    activationKeyPepper: 'local-test-activation-pepper',
    billingRepository: billing,
    stripeGateway: new LocalStripeGateway(),
    stripeWebhookVerifier: new StripeWebhookVerifier(
      'whsec_local_fixture_only',
    ),
    aiProvider: new DeterministicLocalAiProvider(),
    aiQuotaRepository: new LocalAiQuotaRepository(repository, now),
    aiIdempotencyPepper: 'ephemeral-local-ai-idempotency-pepper',
    aiPolicy: {
      shortMaxBodyBytes: 131_072,
      pdfMaxBodyBytes: 1_048_576,
      maxTranslationSegments: 2_000,
      maxResponseBytes: 2_097_152,
    },
    cloudRepository,
    scenarioStorage,
    cloudIdempotencyPepper: 'ephemeral-local-cloud-idempotency-pepper',
    cloudPolicy: { maximumBodyBytes: 4_194_304, downloadTtlSeconds: 300 },
    studioRepository,
    studioNotifier,
    studioInvitationPepper: 'ephemeral-local-studio-invitation-pepper',
    studioPolicy: { invitationTtlSeconds: 86_400, eventPageSize: 100 },
    realtimeTransport,
    ...overrides,
  });
  return {
    repository,
    auth,
    billing,
    cloudRepository,
    scenarioStorage,
    studioRepository,
    studioNotifier,
    realtimeTransport,
    worker,
  };
}
