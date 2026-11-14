/**
 * Which failures are worth retrying, and how long to wait. Only transient
 * upstream conditions retry; input errors fail at once.
 */
import { Vid2ContextError } from '@vid2context/core';
import type { KindEntry } from './kinds.ts';
import type { JobError } from './types.ts';

/** Error codes that may succeed if tried again later. */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set(['rate-limited', 'timeout', 'upstream', 'blocked']);

export type JobFailure = JobError & { retryAfterSec?: number };

/** Turn anything thrown by a handler into the job's error shape. Unknown errors leak no detail. */
export function toJobError(err: unknown): JobFailure {
  if (err instanceof Vid2ContextError) {
    const out: JobFailure = { code: err.code, message: err.message };
    if (err.hint) out.hint = err.hint;
    if (err.retryAfterSec !== undefined) out.retryAfterSec = err.retryAfterSec;
    return out;
  }
  return { code: 'internal', message: 'Internal error while running the job.', hint: 'Check the server log for details.' };
}

/** The public error shape (drops `retryAfterSec`). */
export function publicError(e: JobFailure): JobError {
  return { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
}

/**
 * Delay before the next attempt, or null when the failure must not be
 * retried. Exponential with equal jitter: half the step is fixed, half
 * random. `Retry-After` from the upstream wins when it is longer.
 */
export function retryDelayMs(
  failure: JobFailure,
  attempt: number,
  backoff: KindEntry['backoff'],
  random: () => number = Math.random,
): number | null {
  if (!RETRYABLE_CODES.has(failure.code)) return null;
  const step =
    failure.code === 'blocked' ? backoff.blockedMs : Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, attempt - 1));
  let delay = step / 2 + random() * (step / 2);
  if (failure.retryAfterSec !== undefined) delay = Math.max(delay, failure.retryAfterSec * 1000);
  return Math.round(delay);
}
