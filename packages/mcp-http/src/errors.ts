/**
 * Responses for failures this package answers itself. Bodies follow the HTTP
 * API error shape (`{ error: { code, message, hint }, attempts }`), built from
 * a Vid2ContextError. They are returned, never thrown, so a parent app's
 * onError cannot remap a 401 or 403 to its own status.
 */
import { Vid2ContextError } from '@vid2context/core';

export function errorResponse(err: Vid2ContextError, status: number, headers: Record<string, string> = {}): Response {
  const body = {
    error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
    attempts: [],
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function rateLimited(retryAfterSec: number, what: string): Response {
  return errorResponse(
    new Vid2ContextError('rate-limited', `Too many ${what}.`, {
      hint: `Wait ${retryAfterSec} s and retry. The owner can raise VID2CONTEXT_MCP_RATE_LIMIT.`,
      retryAfterSec,
    }),
    429,
    { 'retry-after': String(retryAfterSec) },
  );
}

/** OAuth 2.0 error response (RFC 6749 section 5.2) for the token, registration and revocation endpoints. */
export function oauthError(error: string, description: string, status = 400, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
