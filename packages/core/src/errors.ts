/**
 * Error taxonomy. Every error a user can see carries a stable `code` and a
 * human `hint` that says how to recover. Surfaces render `hint` verbatim.
 */
export type ErrorCode =
  | 'unsupported-input'
  | 'not-found'
  | 'unavailable'
  | 'no-transcript'
  | 'no-provider'
  | 'all-rungs-failed'
  | 'rate-limited'
  | 'auth'
  | 'blocked'
  | 'too-large'
  | 'timeout'
  | 'upstream'
  | 'bad-request';

export class Vid2ContextError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  /** HTTP status of the upstream response that caused this, when there was one. */
  readonly status?: number;
  /** Seconds to wait before retrying, from Retry-After or the provider's own signal. */
  readonly retryAfterSec?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; status?: number; retryAfterSec?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'Vid2ContextError';
    this.code = code;
    this.hint = opts.hint;
    this.status = opts.status;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

/** True for errors caused by the caller's input; retrying another rung will not help. */
export function isInputError(err: unknown): boolean {
  return err instanceof Vid2ContextError && (err.code === 'unsupported-input' || err.code === 'bad-request');
}

/**
 * Turn a non-2xx fetch Response into a Vid2ContextError with the right code,
 * reading Retry-After and a bounded slice of the body for the message.
 */
export async function errorFromResponse(res: Response, label: string): Promise<Vid2ContextError> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 500);
  } catch {
    body = '';
  }
  const retryAfter = Number(res.headers.get('retry-after'));
  const retryAfterSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
  const msg = `${label}: HTTP ${res.status}${body ? ` ${body}` : ''}`;
  const s = res.status;
  if (s === 429) return new Vid2ContextError('rate-limited', msg, { status: s, retryAfterSec });
  if (s === 401 || s === 403) return new Vid2ContextError('auth', msg, { status: s });
  if (s === 402) return new Vid2ContextError('auth', msg, { status: s, hint: 'The account behind this key is out of credits.' });
  if (s === 404 || s === 410) return new Vid2ContextError('not-found', msg, { status: s });
  if (s === 413) return new Vid2ContextError('too-large', msg, { status: s });
  if (s === 400 || s === 415 || s === 422) return new Vid2ContextError('upstream', msg, { status: s });
  return new Vid2ContextError('upstream', msg, { status: s, retryAfterSec });
}
