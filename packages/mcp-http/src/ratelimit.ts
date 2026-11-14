/**
 * Token bucket per key, kept in the KvStore under `ratelimit:` so limits hold
 * across Workers isolates when the store is shared (D1, KV). The read and
 * write are not atomic: under heavy concurrency a few extra requests can pass,
 * which is fine for abuse protection.
 */
import type { KvStore } from '@vid2context/core';

interface Bucket {
  tokens: number;
  /** Epoch ms of the last update. */
  at: number;
}

export interface RateDecision {
  ok: boolean;
  /** Whole seconds until one token is available, when refused. */
  retryAfterSec: number;
}

/**
 * Take one token from the bucket `key`. The bucket holds `capacity` tokens and
 * refills `capacity` per `windowSec`.
 */
export async function takeToken(kv: KvStore, key: string, capacity: number, windowSec = 60): Promise<RateDecision> {
  if (capacity <= 0) return { ok: true, retryAfterSec: 0 };
  const k = `ratelimit:${key}`;
  const now = Date.now();
  const ratePerMs = capacity / (windowSec * 1000);
  const prev = await kv.kvGet<Bucket>(k);
  const tokens = prev ? Math.min(capacity, prev.tokens + (now - prev.at) * ratePerMs) : capacity;
  if (tokens < 1) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / ratePerMs / 1000)) };
  }
  await kv.kvSet(k, { tokens: tokens - 1, at: now } satisfies Bucket, { ttlSec: windowSec * 2 });
  return { ok: true, retryAfterSec: 0 };
}
