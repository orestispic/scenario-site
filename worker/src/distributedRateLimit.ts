import { CommercialRepositoryError, type RateLimiter } from './types.ts';

export interface LimiterNamespace {
  idFromName(name: string): unknown;
  get(id: never): { fetch(request: Request): Promise<Response> };
}
export interface Bucket {
  count: number;
  resetAt: number;
}
export interface BucketTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface LimiterStorage extends BucketTransaction {
  transaction<T>(
    operation: (transaction: BucketTransaction) => Promise<T>,
  ): Promise<T>;
  setAlarm(time: number): Promise<void>;
  deleteAll(): Promise<void>;
}

export function limitConfiguration(maximum: number, windowMs: number): void {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 100_000 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1000 ||
    windowMs > 3_600_000
  )
    throw new Error('Invalid rate limit configuration');
}

/** One opaque subject/route per object; a transaction serializes requests across Workers. */
export class RateLimitBucket {
  private readonly storage: LimiterStorage;
  constructor(state: { storage: LimiterStorage }) {
    this.storage = state.storage;
  }
  async fetch(request: Request): Promise<Response> {
    const { maximum, windowMs } = (await request.json()) as {
      maximum: number;
      windowMs: number;
    };
    limitConfiguration(maximum, windowMs);
    const now = Date.now();
    const result = await this.storage.transaction(async (tx) => {
      let bucket = await tx.get<Bucket>('bucket');
      if (!bucket || bucket.resetAt <= now)
        bucket = { count: 0, resetAt: now + windowMs };
      const allowed = bucket.count < maximum;
      if (allowed) bucket.count += 1;
      await tx.put('bucket', bucket);
      return { allowed, resetAt: bucket.resetAt };
    });
    await this.storage.setAlarm(result.resetAt);
    return Response.json({ allowed: result.allowed });
  }
  async alarm(): Promise<void> {
    const bucket = await this.storage.get<Bucket>('bucket');
    if (bucket && bucket.resetAt > Date.now())
      await this.storage.setAlarm(bucket.resetAt);
    else await this.storage.deleteAll();
  }
}

export class DistributedRateLimiter implements RateLimiter {
  constructor(
    private readonly namespace: LimiterNamespace,
    private readonly pepper: string,
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly timeoutMs = 2000,
  ) {
    limitConfiguration(maximum, windowMs);
    if (!pepper) throw new Error('Rate limit pepper required');
  }
  async allow(key: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const secret = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(this.pepper),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const hash = await crypto.subtle.sign(
        'HMAC',
        secret,
        new TextEncoder().encode(key),
      );
      const name = [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      const stub = this.namespace.get(this.namespace.idFromName(name) as never);
      const response = await Promise.race([
        stub.fetch(
          new Request('https://limiter.internal/check', {
            method: 'POST',
            body: JSON.stringify({
              maximum: this.maximum,
              windowMs: this.windowMs,
            }),
          }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout')),
            this.timeoutMs,
          );
        }),
      ]);
      if (!response.ok) throw new Error('Limiter unavailable');
      const value = (await response.json()) as { allowed?: unknown };
      if (typeof value.allowed !== 'boolean')
        throw new Error('Invalid limiter response');
      return value.allowed;
    } catch {
      throw new CommercialRepositoryError(
        503,
        'rate_limiter_unavailable',
        'Service temporairement indisponible. Réessayez.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
