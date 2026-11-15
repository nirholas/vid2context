/**
 * Every error the app shows is a Vid2ContextError with a stable code, a hint
 * and the attempts that led to it. These helpers turn API error bodies,
 * network failures and anything else into that shape.
 */
import { type Attempt, type ErrorCode, Vid2ContextError } from '@vid2context/core';

const CODES: ErrorCode[] = [
  'unsupported-input',
  'not-found',
  'unavailable',
  'no-transcript',
  'no-provider',
  'all-rungs-failed',
  'rate-limited',
  'auth',
  'blocked',
  'too-large',
  'timeout',
  'upstream',
  'bad-request',
];

export interface ApiErrorBody {
  error: { code: string; message: string; hint?: string };
  attempts?: Attempt[];
}

export type AppError = Vid2ContextError & { attempts: Attempt[] };

export function withAttempts(err: Vid2ContextError, attempts: Attempt[] = []): AppError {
  return Object.assign(err, { attempts });
}

export function isApiErrorBody(v: unknown): v is ApiErrorBody {
  const e = (v as ApiErrorBody | null)?.error;
  return !!e && typeof e === 'object' && typeof e.code === 'string' && typeof e.message === 'string';
}

/** Seconds from a Retry-After header (delta seconds or an HTTP date), or undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Build the error for a non-2xx API response from its standard body (and its Retry-After header, when sent). */
export function fromApiBody(body: ApiErrorBody, status: number, retryAfterSec?: number): AppError {
  const known = CODES.includes(body.error.code as ErrorCode);
  const code: ErrorCode = known ? (body.error.code as ErrorCode) : 'upstream';
  const hint =
    body.error.hint ??
    (body.error.code === 'internal'
      ? 'The server hit an unexpected error. Its log (stderr) has the details. Try again, and report it if it keeps happening.'
      : undefined);
  return withAttempts(new Vid2ContextError(code, body.error.message, { hint, status, retryAfterSec }), body.attempts ?? []);
}

export function attemptsOfError(err: unknown): Attempt[] {
  const a = (err as { attempts?: unknown } | null)?.attempts;
  return Array.isArray(a) ? (a as Attempt[]) : [];
}

export function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

/** Anything thrown, as an AppError the error panel can show. */
export function toAppError(err: unknown): AppError {
  if (err instanceof Vid2ContextError) return withAttempts(err, attemptsOfError(err));
  const message = err instanceof Error ? err.message : String(err);
  return withAttempts(
    new Vid2ContextError('upstream', message || 'An unexpected error happened in the web app.', {
      hint: 'Reload the page and try again. If it keeps happening, open the browser console for details and report it.',
      cause: err,
    }),
    attemptsOfError(err),
  );
}
