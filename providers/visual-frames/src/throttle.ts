/**
 * Per-rung request spacing for hosted vision services (runtime-neutral).
 *
 * Keyless OVH allows about 2 requests per minute per model, and free Gemini
 * keys have a per-minute cap too. A rung that was used too recently does not
 * wait: it throws `rate-limited` with the remaining seconds, so the chain
 * cools it down and moves on to the next rung. The frame pipeline reads
 * `throttleRemainingMs` to decide how long to wait when every rung is resting.
 */
import { Vid2ContextError } from '@vid2context/core';

const nextAllowed = new Map<string, number>();

/** Milliseconds until `key` may send again (0 when it may send now). */
export function throttleRemainingMs(key: string, now = Date.now()): number {
  return Math.max(0, (nextAllowed.get(key) ?? 0) - now);
}

/** Claim a request slot for `key`, or throw `rate-limited` when the last one was less than `intervalMs` ago. */
export function takeSlot(key: string, intervalMs: number, label: string, now = Date.now()): void {
  if (intervalMs <= 0) return;
  const wait = throttleRemainingMs(key, now);
  if (wait > 0) {
    throw new Vid2ContextError('rate-limited', `${label}: spacing requests, next slot in ${Math.ceil(wait / 1000)} s.`, {
      retryAfterSec: Math.ceil(wait / 1000),
      hint: 'This service allows only a few requests per minute; the chain uses another rung meanwhile.',
    });
  }
  nextAllowed.set(key, now + intervalMs);
}

/** Forget all slots (tests). */
export function resetThrottle(): void {
  nextAllowed.clear();
}
