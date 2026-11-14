/**
 * Token-bucket rate limiting over a KvStore (`ratelimit:<who>` keys). The
 * bucket holds up to `burst` tokens and refills at `perMinute` tokens per
 * minute; each request takes one. Storage backends with a KvStore share
 * buckets across processes; otherwise a process-local MemoryKv is used.
 * KV updates are not atomic, so concurrent requests can occasionally slip one
 * extra request through; that is fine for abuse protection.
 */
import type { KvStore } from '@vid2context/core';

interface Bucket {
  /** Tokens left at `at`. */
  t: number;
  /** Epoch ms of the last update. */
  at: number;
}

export type TakeResult = { ok: true; remaining: number; limit: number } | { ok: false; retryAfterSec: number; limit: number };

export async function takeToken(
  kv: KvStore,
  who: string,
  opts: { perMinute: number; burst: number; now?: number },
): Promise<TakeResult> {
  const now = opts.now ?? Date.now();
  const key = `ratelimit:${who}`;
  const saved = await kv.kvGet<Bucket>(key);
  const perMs = opts.perMinute / 60_000;
  const tokens = saved ? Math.min(opts.burst, saved.t + (now - saved.at) * perMs) : opts.burst;
  // A full bucket refills in burst / rate; after that the key can expire.
  const ttlSec = Math.ceil(opts.burst / perMs / 1000) + 1;
  if (tokens < 1) {
    await kv.kvSet(key, { t: tokens, at: now } satisfies Bucket, { ttlSec });
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)), limit: opts.burst };
  }
  await kv.kvSet(key, { t: tokens - 1, at: now } satisfies Bucket, { ttlSec });
  return { ok: true, remaining: Math.floor(tokens - 1), limit: opts.burst };
}
