import { attemptsOf, Vid2ContextError } from '@vid2context/core';

/** Resolves after `ms`, or at once when the signal aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Each worker
 * waits `delayMs` between its items (politeness toward the platform), and no
 * new item starts once `signal` aborts.
 */
export async function eachLimit<T>(
  items: T[],
  limit: number,
  delayMs: number,
  signal: AbortSignal | undefined,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    let first = true;
    while (next < items.length && !signal?.aborted) {
      if (!first) await sleep(delayMs, signal);
      first = false;
      // Another worker may have taken the last item during the pause.
      if (signal?.aborted || next >= items.length) return;
      const item = items[next++] as T;
      await fn(item);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
}

export interface ErrorInfo {
  code: string;
  message: string;
  hint?: string;
  /** The last failed step behind the error, from its attempts: "youtube-captions blocked: ...HTTP 429...". */
  cause?: string;
}

export function errorInfo(err: unknown): ErrorInfo {
  const failedStep = attemptsOf(err)
    .filter((a) => a.outcome === 'error')
    .at(-1);
  const cause = failedStep
    ? `${failedStep.id} ${failedStep.reason ?? 'error'}${failedStep.detail ? `: ${failedStep.detail}` : ''}`.slice(0, 300)
    : undefined;
  if (err instanceof Vid2ContextError) {
    return {
      code: err.code,
      message: err.message.slice(0, 500),
      ...(err.hint ? { hint: err.hint } : {}),
      ...(cause && failedStep?.detail !== err.message ? { cause } : {}),
    };
  }
  return {
    code: 'internal',
    message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    ...(cause ? { cause } : {}),
  };
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}
