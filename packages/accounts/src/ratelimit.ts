/**
 * Per-IP limits in front of every hosted route.
 *
 * MemoryTokenBucket: a token bucket per IP inside one process. Exact, cheap,
 * and the right tool on Node (one server, or one per container).
 *
 * KvWindowLimiter: for Cloudflare Workers, where every request may land on a
 * different isolate. Counts requests per IP in coarse 60-second windows in
 * the KvStore. Cloudflare KV is eventually consistent (a write can take up to
 * about 60 seconds to reach other locations) and has no atomic increment, so
 * concurrent requests can read the same count: treat the limit as a soft cap
 * that stops sustained floods, not an exact one. Every counted request is a
 * KV write, which matters on the free KV plan's daily write allowance.
 */
import type { KvStore } from '@vid2context/core';

export type LimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export interface IpLimiter {
  take(key: string, now?: number): Promise<LimitResult>;
}

export class MemoryTokenBucket implements IpLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  /** `capacity` is the burst size, `perMinute` the steady refill rate. */
  constructor(
    private readonly capacity: number,
    private readonly perMinute: number,
    private readonly maxKeys = 50_000,
  ) {}

  async take(key: string, now = Date.now()): Promise<LimitResult> {
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * rate);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.store(key, b, now);
      return { ok: true };
    }
    this.store(key, b, now);
    const waitMs = rate > 0 ? (1 - b.tokens) / rate : 60_000;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  private store(key: string, b: { tokens: number; at: number }, now: number): void {
    this.buckets.delete(key);
    this.buckets.set(key, b);
    if (this.buckets.size <= this.maxKeys) return;
    // Map keeps insertion order, so the first entries are the least recently used.
    const rate = this.perMinute / 60_000;
    for (const [k, v] of this.buckets) {
      if (this.buckets.size <= this.maxKeys * 0.9) break;
      const full = v.tokens + (now - v.at) * rate >= this.capacity;
      if (full || this.buckets.size > this.maxKeys) this.buckets.delete(k);
    }
  }
}

export class KvWindowLimiter implements IpLimiter {
  constructor(
    private readonly kv: KvStore,
    private readonly perMinute: number,
  ) {}

  async take(key: string, now = Date.now()): Promise<LimitResult> {
    const window = Math.floor(now / 60_000);
    const k = `ratelimit:accounts:ip:${key}:${window}`;
    const count = (await this.kv.kvGet<number>(k)) ?? 0;
    if (count >= this.perMinute) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000)) };
    }
    // 120 s keeps the window readable to its end on stores with a 60 s minimum TTL (Cloudflare KV).
    await this.kv.kvSet(k, count + 1, { ttlSec: 120 });
    return { ok: true };
  }
}
