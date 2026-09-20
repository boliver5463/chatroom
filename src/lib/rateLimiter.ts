export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens left after the attempt (floored at 0). */
  remaining: number;
  /** Milliseconds until one token is available again. 0 when allowed. */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Token bucket keyed by an arbitrary string (user id, socket id, IP).
 *
 * A bucket allows a short burst — normal for chat, where people paste a few
 * lines at once — then settles to a steady rate, which is what actually stops
 * a spammer. Tokens are computed lazily on access, so there is no timer per
 * key and idle keys cost nothing until the sweep collects them.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly burst: number,
    private readonly refillPerSecond: number,
  ) {}

  consume(key: string, cost = 1): RateLimitDecision {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.burst, lastRefillMs: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedSeconds = (now - bucket.lastRefillMs) / 1000;
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedSeconds * this.refillPerSecond);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }

    const deficit = cost - bucket.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil((deficit / this.refillPerSecond) * 1000),
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Drops buckets that have sat full long enough to be indistinguishable from
   * a fresh one. Without this the map grows with every user ever seen.
   */
  sweep(): number {
    const now = Date.now();
    const idleMs = (this.burst / this.refillPerSecond) * 1000 * 2;
    let removed = 0;

    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefillMs > idleMs) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}
