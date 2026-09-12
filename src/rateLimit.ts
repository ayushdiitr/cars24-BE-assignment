/**
 * Token-bucket rate limiter for the LLM-backed endpoint.
 *
 */

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

export class TokenBucket {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();

  private capacity: number;
  private refillPerMinute: number;

  constructor(
    capacity: number = Number(process.env.RATE_LIMIT_BURST ?? 10),
    refillPerMinute: number = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 20),
  ) {
    this.capacity = capacity;
    this.refillPerMinute = refillPerMinute;
  }

  take(key: string, now: number = Date.now()): RateLimitResult {
    const bucket = this.buckets.get(key) ?? {
      tokens: this.capacity,
      lastRefill: now,
    };

    const elapsedMs = now - bucket.lastRefill;
    const refilled = (elapsedMs / 60_000) * this.refillPerMinute;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refilled);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const msPerToken = 60_000 / this.refillPerMinute;
      const retryAfterMs = Math.ceil((1 - bucket.tokens) * msPerToken);
      this.buckets.set(key, bucket);
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: 0,
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}
