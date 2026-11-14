/**
 * Secret redaction for logs, attempt details, errors and health output.
 * Replaces credentials with `[redacted]`: sensitive header values, secret
 * query parameters, well-known key shapes and the literal values of every
 * env var whose name says it holds a secret.
 */
import type { Env } from '../types.ts';

export const REDACTED = '[redacted]';

/** Header and field names whose whole value is a credential. */
const SECRET_FIELD =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-goog-api-key|x-auth-token|x-access-token|api_?key|apikey|access_?token|refresh_?token|id_?token|client_?secret|password|passwd|secret|private_?key)$/i;

/** Env var names (and object keys) that hold secrets. */
const SECRET_ENV_NAME = /_(KEY|KEYS|TOKEN|SECRET|PASSWORD|COOKIE)$/i;

const MIN_ENV_SECRET = 8;

/** Known credential shapes. Each must stand alone (not inside a longer identifier). */
const KEY_SHAPES: RegExp[] = [
  /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_-])sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_-])gsk_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g,
  /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{22,}/g,
  /(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_-])r8_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9_-])csk-[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_-])ya29\.[A-Za-z0-9_-]{20,}/g,
];

/** `Bearer xxx` and `Basic xxx` anywhere in text. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** `Authorization: value`, `"x-api-key": "value"`, `cookie=value` in text (headers dumped into a message). */
const HEADER_IN_TEXT =
  /(["']?\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-goog-api-key)["']?\s*[:=]\s*["']?)([^"'\r\n]+)/gi;

/** Secret query parameters in URLs. */
const SECRET_QUERY =
  /([?&;](?:key|api_key|apikey|api-key|token|access_token|refresh_token|id_token|sig|signature|client_secret|password|x-goog-api-key)=)[^&#\s"'<>]*/gi;

/** The password part of `scheme://user:password@host` in URLs. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)[^@\s/]+@/gi;

const envMatchers = new WeakMap<Env, RegExp | null>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One combined matcher for the secret env values, built once per env object. */
function envMatcher(env: Env | undefined): RegExp | null {
  if (!env) return null;
  const cached = envMatchers.get(env);
  if (cached !== undefined) return cached;
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_ENV_NAME.test(name)) continue;
    const parts = /_KEYS$/i.test(name) ? [value, ...value.split(/[,\s]+/)] : [value];
    for (const p of parts) {
      const v = p.trim();
      if (v.length >= MIN_ENV_SECRET) values.add(v);
    }
  }
  const sorted = [...values].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const matcher = sorted.length ? new RegExp(sorted.join('|'), 'g') : null;
  envMatchers.set(env, matcher);
  return matcher;
}

function redactString(s: string, env: Env | undefined): string {
  if (s.length < MIN_ENV_SECRET) return s;
  let out = s;
  const m = envMatcher(env);
  if (m) out = out.replace(m, REDACTED);
  out = out.replace(HEADER_IN_TEXT, `$1${REDACTED}`);
  out = out.replace(AUTH_SCHEME, `$1 ${REDACTED}`);
  out = out.replace(SECRET_QUERY, `$1${REDACTED}`);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  for (const re of KEY_SHAPES) out = out.replace(re, REDACTED);
  return out;
}

function isSecretKey(key: string): boolean {
  return SECRET_FIELD.test(key) || SECRET_ENV_NAME.test(key);
}

function walk(value: unknown, env: Env | undefined, ancestors: Set<object>): unknown {
  if (typeof value === 'string') return redactString(value, env);
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[circular]';
  if (value instanceof URL) return redactString(value.href, env);
  if (value instanceof Date || value instanceof RegExp || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  ancestors.add(value);
  try {
    if (typeof Headers !== 'undefined' && value instanceof Headers) {
      const out: Record<string, string> = {};
      value.forEach((v, k) => {
        out[k] = isSecretKey(k) ? REDACTED : redactString(v, env);
      });
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, env, ancestors));
    if (value instanceof Map) {
      const out = new Map<unknown, unknown>();
      for (const [k, v] of value) out.set(k, typeof k === 'string' && isSecretKey(k) ? REDACTED : walk(v, env, ancestors));
      return out;
    }
    const out: Record<string, unknown> = {};
    if (value instanceof Error) {
      out.name = value.name;
      out.message = redactString(value.message, env);
    }
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) && v !== undefined && v !== null && v !== '' ? REDACTED : walk(v, env, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Redact secrets from a string or a plain object (deep, cycle-safe; the input
 * is never modified). Pass the context env so literal key values are caught
 * even when they have no recognizable shape. Errors become plain objects with
 * a redacted `message`; Headers become plain objects.
 */
export function redact<T>(value: T, env?: Env): T {
  return walk(value, env, new Set()) as T;
}
