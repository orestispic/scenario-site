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

export async function createLocalRuntime(
  overrides: Partial<WorkerDependencies> = {},
  now = Date.now,
) {
  const repository = new LocalTestRepository();
  const auth = new LocalAuthService(repository, now);
  repository.logout = (token?: string) => auth.logout(token ?? '');
  const billing = new LocalBillingRepository(repository);
  const selector = new LocalTestTokenVerifier();
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
    ...overrides,
  });
  return { repository, auth, billing, worker };
}
