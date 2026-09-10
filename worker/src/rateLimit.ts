import type { RateLimiter } from "./types.ts";

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maximumRequests: number, private readonly windowMs: number) {}

  async allow(key: string, now: number): Promise<boolean> {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.maximumRequests) return false;
    bucket.count += 1;
    return true;
  }
}
