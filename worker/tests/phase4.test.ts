/* oxlint-disable typescript/no-floating-promises */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DistributedRateLimiter,
  RateLimitBucket,
  type LimiterStorage,
  type LimiterNamespace,
} from '../src/distributedRateLimit.ts';
import { StripeRestGateway } from '../src/stripe.ts';
import { StripeWebhookVerifier } from '../src/stripeWebhook.ts';

function namespaceFixture() {
  const values = new Map<string, unknown>();
  let queue: Promise<unknown> = Promise.resolve();
  const storage: LimiterStorage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    transaction: async (fn) => {
      const result = queue.then(() => fn(storage));
      queue = result.catch(() => {});
      return result;
    },
    setAlarm: async () => {},
    deleteAll: async () => {
      values.clear();
    },
  };
  const names: string[] = [];
  const namespace: LimiterNamespace = {
    idFromName: (name) => {
      names.push(name);
      return name;
    },
    get: () => ({
      fetch: (request) => new RateLimitBucket({ storage }).fetch(request),
    }),
  };
  return { storage, namespace, names };
}

test('distributed limit is atomic across instances/restarts, expires, stores no identity', async () => {
  const fixture = namespaceFixture();
  const limiters = [
    new DistributedRateLimiter(fixture.namespace, 'fixture-pepper', 5, 1000),
    new DistributedRateLimiter(fixture.namespace, 'fixture-pepper', 5, 1000),
  ];
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      limiters[index % 2].allow('sensitive@example.invalid'),
    ),
  );
  assert.equal(results.filter(Boolean).length, 5);
  assert.ok(fixture.names.every((name) => /^[a-f0-9]{64}$/.test(name)));
  await fixture.storage.put('bucket', { count: 5, resetAt: Date.now() - 1 });
  assert.equal(await limiters[0].allow('sensitive@example.invalid'), true);
});

test('limiter rejects outages, timeout, malformed response and invalid bounds', async () => {
  const unavailable: LimiterNamespace = {
    idFromName: (name) => name,
    get: () => ({
      fetch: async () => {
        throw new Error('unavailable');
      },
    }),
  };
  await assert.rejects(
    new DistributedRateLimiter(unavailable, 'pepper', 1, 1000).allow('subject'),
    { code: 'rate_limiter_unavailable', status: 503 },
  );
  unavailable.get = () => ({ fetch: async () => new Promise(() => {}) });
  await assert.rejects(
    new DistributedRateLimiter(unavailable, 'pepper', 1, 1000, 10).allow(
      'subject',
    ),
    { status: 503 },
  );
  unavailable.get = () => ({
    fetch: async () => Response.json({ allowed: 'true' }),
  });
  await assert.rejects(
    new DistributedRateLimiter(unavailable, 'pepper', 1, 1000).allow('subject'),
    { status: 503 },
  );
  assert.throws(
    () => new DistributedRateLimiter(unavailable, 'pepper', NaN, 1000),
  );
  assert.throws(
    () => new DistributedRateLimiter(unavailable, 'pepper', 1, Infinity),
  );
});

test('Stripe rejects live credentials and unbounded signature tolerance before any request', () => {
  assert.throws(() => new StripeRestGateway('sk_live_fixture'));
  assert.throws(() => new StripeRestGateway('rk_live_fixture'));
  assert.throws(() => new StripeWebhookVerifier('fixture', NaN));
  assert.throws(() => new StripeWebhookVerifier('fixture', 301));
});
