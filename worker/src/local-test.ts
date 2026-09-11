import {
  LocalTestRepository,
  LocalTestTokenVerifier,
} from './localTestRepository.ts';
import { createEphemeralOfflineGrantSigner } from './offlineGrant.ts';
import { InMemoryRateLimiter } from './rateLimit.ts';
import { createCommercialWorker } from './worker.ts';
import { LocalBillingRepository } from './localBillingRepository.ts';
import { LocalStripeGateway } from './localStripeGateway.ts';
import { StripeWebhookVerifier } from './stripeWebhook.ts';

const LOCAL_WEBHOOK_SECRET = 'whsec_local_fixture_only';
type LocalRuntime = {
  worker: ReturnType<typeof createCommercialWorker>;
  billing: LocalBillingRepository;
};
let localWorker: Promise<LocalRuntime> | null = null;

async function getLocalWorker() {
  localWorker ??= createEphemeralOfflineGrantSigner().then(
    (offlineGrantSigner) => {
      const repository = new LocalTestRepository();
      const billing = new LocalBillingRepository(repository);
      const worker = createCommercialWorker({
        environment: 'test',
        allowedOrigins: [
          'http://localhost:1420',
          'http://localhost:3000',
          'http://127.0.0.1:1420',
          'http://127.0.0.1:3000',
        ],
        repository,
        tokenVerifier: new LocalTestTokenVerifier(),
        offlineGrantSigner,
        rateLimiter: new InMemoryRateLimiter(300, 60_000),
        deviceFingerprintPepper: 'ephemeral-local-test-pepper',
        activationKeyPepper: 'local-test-activation-pepper',
        billingRepository: billing,
        stripeGateway: new LocalStripeGateway(),
        stripeWebhookVerifier: new StripeWebhookVerifier(LOCAL_WEBHOOK_SECRET),
      });
      return { worker, billing };
    },
  );
  return localWorker;
}

const localTestWorker = {
  async fetch(request: Request): Promise<Response> {
    const runtime = await getLocalWorker();
    const url = new URL(request.url);
    if (
      url.pathname === '/_local/admin/activation-keys' &&
      request.method === 'POST'
    ) {
      if (request.headers.get('x-scenario-local-admin') !== 'phase3-local-only')
        return Response.json({ code: 'local_admin_required' }, { status: 403 });
      const body = (await request.json()) as {
        selectionId?: unknown;
        maximumActivations?: unknown;
        expiresAt?: unknown;
      };
      if (
        typeof body.selectionId !== 'string' ||
        typeof body.maximumActivations !== 'number' ||
        !(body.expiresAt === null || typeof body.expiresAt === 'string')
      )
        return Response.json({ code: 'invalid_payload' }, { status: 400 });
      return Response.json(
        await runtime.billing.createLocalActivationKey({
          selectionId: body.selectionId,
          maximumActivations: body.maximumActivations,
          expiresAt: body.expiresAt,
        }),
        { status: 201, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (
      url.pathname.startsWith('/_local/admin/activation-keys/') &&
      request.method === 'DELETE'
    ) {
      if (request.headers.get('x-scenario-local-admin') !== 'phase3-local-only')
        return Response.json({ code: 'local_admin_required' }, { status: 403 });
      const keyId = url.pathname.split('/').at(-1)!;
      await runtime.billing.revokeActivationKey({
        keyId,
        actorProfileId: 'local-admin',
      });
      return new Response(null, { status: 204 });
    }
    return runtime.worker.fetch(request);
  },
};

export default localTestWorker;
