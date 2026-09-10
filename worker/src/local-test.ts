import { LocalTestRepository, LocalTestTokenVerifier } from "./localTestRepository.ts";
import { createEphemeralOfflineGrantSigner } from "./offlineGrant.ts";
import { InMemoryRateLimiter } from "./rateLimit.ts";
import { createCommercialWorker } from "./worker.ts";

let localWorker: Promise<ReturnType<typeof createCommercialWorker>> | null = null;

async function getLocalWorker() {
  localWorker ??= createEphemeralOfflineGrantSigner().then((offlineGrantSigner) => createCommercialWorker({
    environment: "test",
    allowedOrigins: ["http://localhost:1420", "http://localhost:3000", "http://127.0.0.1:1420", "http://127.0.0.1:3000"],
    repository: new LocalTestRepository(),
    tokenVerifier: new LocalTestTokenVerifier(),
    offlineGrantSigner,
    rateLimiter: new InMemoryRateLimiter(300, 60_000),
    deviceFingerprintPepper: "ephemeral-local-test-pepper",
  }));
  return localWorker;
}

const localTestWorker = {
  async fetch(request: Request): Promise<Response> {
    return (await getLocalWorker()).fetch(request);
  },
};

export default localTestWorker;
