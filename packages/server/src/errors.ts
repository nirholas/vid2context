/**
 * Error rendering for the HTTP API. Core errors (`Vid2ContextError`) map to a
 * status through STATUS_BY_CODE. The server adds a few codes of its own that
 * describe the caller's request rather than a video (`unauthorized`,
 * `forbidden`), and `internal` for anything unexpected (no detail leaked).
 */
import { type Attempt, attemptsOf, type ErrorCode, Vid2ContextError } from '@vid2context/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** HTTP status for each error code. Upstream failures are 502/503, never 500. */
export const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  'unsupported-input': 400,
  'bad-request': 400,
  'not-found': 404,
  unavailable: 403,
  'no-transcript': 422,
  'too-large': 413,
  'rate-limited': 429,
  timeout: 504,
  blocked: 503,
  'no-provider': 503,
  'all-rungs-failed': 502,
  auth: 502,
  upstream: 502,
};

/** Codes the server itself raises about the caller's credentials. */
export type ServerErrorCode = 'unauthorized' | 'forbidden';

/** An error about the HTTP request itself (credentials, scopes), not about a video or a provider. */
export class HttpError extends Error {
  readonly code: ServerErrorCode;
  readonly status: ContentfulStatusCode;
  readonly hint?: string;
  readonly headers: Record<string, string>;

  constructor(code: ServerErrorCode, status: ContentfulStatusCode, message: string, opts: { hint?: string; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.hint = opts.hint;
    this.headers = opts.headers ?? {};
  }
}

export interface ErrorBody {
  error: { code: string; message: string; hint?: string };
  attempts: Attempt[];
}

export interface RenderedError {
  status: ContentfulStatusCode;
  body: ErrorBody;
  headers: Record<string, string>;
  /** True when the error was not one we raise on purpose (logged, rendered as `internal`). */
  unexpected: boolean;
}

/** The standard error body, status and headers for any thrown value. */
export function renderError(err: unknown): RenderedError {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }, attempts: [] },
      headers: err.headers,
      unexpected: false,
    };
  }
  if (err instanceof Vid2ContextError) {
    const headers: Record<string, string> = {};
    if ((err.code === 'rate-limited' || err.code === 'blocked' || err.code === 'no-provider') && err.retryAfterSec) {
      headers['retry-after'] = String(Math.max(1, Math.ceil(err.retryAfterSec)));
    }
    return {
      status: STATUS_BY_CODE[err.code] ?? 500,
      body: { error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }, attempts: attemptsOf(err) },
      headers,
      unexpected: false,
    };
  }
  return {
    status: 500,
    body: { error: { code: 'internal', message: 'Internal error' }, attempts: attemptsOf(err) },
    headers: {},
    unexpected: true,
  };
}

export function badRequest(message: string, hint?: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}
