interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Per-client token bucket. Each client starts with `capacity` tokens; every
 * request takes one, and tokens refill continuously at `refillPerSecond`.
 */
export class TokenBucket {
  private buckets = new Map<string, Bucket>();

  constructor(
    private capacity: number,
    private refillPerSecond: number,
    private now: () => number = Date.now,
  ) {}

  /**
   * Tries to take a token for `key` (the client IP).
   * Returns 0 if allowed, otherwise the number of seconds until a token is available.
   */
  take(key: string): number {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: t };
    const elapsed = (t - b.updatedAt) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond);
    b.updatedAt = t;
    this.buckets.set(key, b);

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / this.refillPerSecond);
  }

  /** Drops buckets that are full again, so memory doesn't grow with every IP ever seen. */
  sweep(): void {
    const t = this.now();
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((t - b.updatedAt) / 1000) * this.refillPerSecond >= this.capacity) this.buckets.delete(key);
    }
  }
}
