/**
 * Retries for transient YouTube failures: exponential backoff with full
 * jitter (a random wait between 0 and min(cap, base * 2^n)) on rate-limits
 * and 5xx, at most 3 retries, honouring Retry-After. A `blocked` error is
 * never retried: repeating a request from a flagged IP only prolongs the
 * block.
 */
import { type Ctx, Vid2ContextError } from '@vid2context/core';

export const MAX_RETRIES = 3;
const BASE_MS = 1000;
const CAP_MS = 8000;
/** A Retry-After longer than this is not waited out inside a request; the error goes to the caller. */
const MAX_WAIT_MS = 30_000;

export function isRetryable(err: unknown): err is Vid2ContextError {
  if (!(err instanceof Vid2ContextError)) return false;
  if (err.code === 'rate-limited') return true;
  return err.code === 'upstream' && err.status !== undefined && err.status >= 500;
}

/** Delay before retry number `attempt` (0-based). `random` returns [0, 1). */
export function backoffDelayMs(attempt: number, retryAfterSec?: number, random: () => number = Math.random): number {
  if (retryAfterSec !== undefined && retryAfterSec > 0) return retryAfterSec * 1000;
  return Math.floor(random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(ctx: Ctx, label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_RETRIES) throw err;
      const wait = backoffDelayMs(attempt, err.retryAfterSec);
      if (wait > MAX_WAIT_MS) throw err;
      ctx.log.info('youtube: retrying', { label, attempt: attempt + 1, waitMs: wait, code: err.code, status: err.status });
      await sleep(wait, ctx.signal);
    }
  }
}
