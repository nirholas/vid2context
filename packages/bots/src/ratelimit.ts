/**
 * Sliding-window rate limits held in memory, one limiter per routes instance.
 * On Workers each isolate has its own memory, so the limit is per instance:
 * a cheap guard against one chat or user flooding the bot, not a global quota.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Upper bound on tracked keys, so a flood of distinct ids cannot grow memory without limit. */
const MAX_KEYS = 10_000;

export interface RateDecision {
  ok: boolean;
  /** Seconds until the oldest counted request leaves the window, when blocked. */
  retryAfterSec?: number;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number = HOUR_MS) {}

  /**
   * Count one request against every key (for example the chat and the user),
   * but only when all of them are under `limit`. A limit of 0 blocks everything.
   */
  take(keys: string[], limit: number, now: number = Date.now()): RateDecision {
    const since = now - this.windowMs;
    let retryAfterMs = 0;
    for (const key of keys) {
      const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
      this.hits.set(key, recent);
      if (recent.length >= limit) {
        const oldest = recent[0] ?? now;
        retryAfterMs = Math.max(retryAfterMs, oldest + this.windowMs - now);
      }
    }
    if (limit <= 0) return { ok: false, retryAfterSec: Math.ceil(this.windowMs / 1000) };
    if (retryAfterMs > 0) return { ok: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
    for (const key of keys) this.hits.get(key)?.push(now);
    this.prune(since);
    return { ok: true };
  }

  private prune(since: number): void {
    if (this.hits.size <= MAX_KEYS) return;
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= since)) this.hits.delete(key);
    }
    // Still too many active keys: drop the oldest-inserted ones.
    for (const key of this.hits.keys()) {
      if (this.hits.size <= MAX_KEYS) break;
      this.hits.delete(key);
    }
  }
}

/** Remembers ids already handled (Telegram update_id, Slack event_id) so platform retries are not processed twice. */
export class SeenIds {
  private ids = new Set<string>();

  constructor(private readonly max = 5_000) {}

  /** True when the id was seen before; otherwise records it. */
  seen(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > this.max) {
      const first = this.ids.values().next().value;
      if (first !== undefined) this.ids.delete(first);
    }
    return false;
  }
}

export function formatWait(sec: number): string {
  if (sec < 90) return `${sec} seconds`;
  return `${Math.ceil(sec / 60)} minutes`;
}
