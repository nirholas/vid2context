/**
 * Maps driver errors (postgres.js, Neon HTTP, PGlite) to Vid2ContextError
 * codes with hints that name the setting to check. Messages are scrubbed of
 * the connection string and password, and the original error is not attached
 * as a cause, so nothing secret reaches logs or API responses.
 */
import { Vid2ContextError } from '@vid2context/core';

const URL_HINT = 'Check VID2CONTEXT_DATABASE_URL or DATABASE_URL.';

interface DriverError {
  code?: unknown;
  errno?: unknown;
  message?: unknown;
}

/** Strings that must never appear in an error: the URL, its password and its user:password pair. */
export function secretsOf(url: string): string[] {
  const out = [url];
  try {
    const u = new URL(url);
    if (u.password) {
      out.push(u.password, decodeURIComponent(u.password));
      out.push(`${u.username}:${u.password}`);
    }
  } catch {
    // Not parseable: the whole string is still scrubbed.
  }
  return out.filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
}

export function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) out = out.split(s).join('***');
  // Any other connection string that slipped into a message.
  return out.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://***');
}

export function toStorageError(err: unknown, secrets: string[]): Vid2ContextError {
  if (err instanceof Vid2ContextError) return err;
  const e = (err ?? {}) as DriverError;
  const code = typeof e.code === 'string' ? e.code : '';
  const raw = typeof e.message === 'string' ? e.message : String(err);
  const message = `Postgres: ${scrub(raw, secrets)}${code && /^[0-9A-Z]{5}$/.test(code) ? ` (SQLSTATE ${code})` : ''}`;
  const lower = raw.toLowerCase();

  if (code === '28P01' || code === '28000') {
    return new Vid2ContextError('auth', message, { hint: `The database rejected the user or password. ${URL_HINT}` });
  }
  if (code === '42501') {
    return new Vid2ContextError('auth', message, {
      hint: 'The database role lacks a privilege. Grant it CREATE on the database (or on the schema), or set VID2CONTEXT_PG_SCHEMA to a schema the role owns.',
    });
  }
  if (code === '3D000') {
    return new Vid2ContextError('unavailable', message, {
      hint: `The database named in the URL does not exist. Create it or fix the name. ${URL_HINT}`,
    });
  }
  if ((code === '0A000' || code === '58P01' || code === '42704') && lower.includes('vector')) {
    return new Vid2ContextError('unavailable', message, {
      hint: 'pgvector is not installed on this server. Enable the "vector" extension (Neon, Supabase and Cloud SQL ship it) or run the pgvector/pgvector Docker image.',
    });
  }
  if (code === '57014') {
    return new Vid2ContextError('timeout', message, {
      hint: 'A query hit the statement timeout. Raise VID2CONTEXT_PG_STATEMENT_TIMEOUT_MS or narrow the query.',
    });
  }
  if (code === '53300' || code === '53400') {
    return new Vid2ContextError('rate-limited', message, {
      hint: "The server has no free connections. Lower VID2CONTEXT_PG_POOL_MAX or use the provider's pooled connection string.",
      retryAfterSec: 5,
    });
  }
  if (code === '22P05' || code === '22021') {
    return new Vid2ContextError('bad-request', message, {
      hint: 'The text contains a character Postgres cannot store (such as a NUL byte). Clean the input and retry.',
    });
  }
  if (code === 'CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return new Vid2ContextError('timeout', message, {
      hint: `Connecting to the database timed out. Check the host, port and firewall. ${URL_HINT}`,
    });
  }
  if (
    [
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNRESET',
      'EHOSTUNREACH',
      'CONNECTION_CLOSED',
      'CONNECTION_ENDED',
      'CONNECTION_DESTROYED',
    ].includes(code) ||
    code.startsWith('08') ||
    code === '57P01' ||
    code === '57P03'
  ) {
    return new Vid2ContextError('unavailable', message, {
      hint: `Could not reach the database. Check that it is running and that the host and port are right. ${URL_HINT}`,
    });
  }
  if (lower.includes('ssl') || lower.includes('certificate')) {
    return new Vid2ContextError('unavailable', message, {
      hint: `The TLS handshake failed. Add or change ?sslmode= in the URL (require for hosted databases, disable for a local container). ${URL_HINT}`,
    });
  }
  if (lower.includes('fetch failed') || lower.includes('error connecting to database')) {
    return new Vid2ContextError('unavailable', message, { hint: `Could not reach the Neon HTTP endpoint. ${URL_HINT}` });
  }
  return new Vid2ContextError('upstream', message, { hint: 'Postgres returned an unexpected error. Check the server logs.' });
}
