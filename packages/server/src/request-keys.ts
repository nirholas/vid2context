/**
 * Provider keys sent with one request (bring your own key).
 *
 *   X-Vid2Context-Keys: {"GROQ_API_KEY":"gsk_...","SUPADATA_API_KEY":"sd_..."}
 *
 * When a run fails for lack of a key, the caller can retry with its own key
 * instead of asking the operator to add one. The keys are merged into that
 * request's env only: never stored, never logged (attempt details are
 * redacted against the env), and never seen by other requests. Cooldowns
 * are keyed by credential (core chain.ts), so a rejected user key does not
 * cool a rung down for anyone else.
 *
 * Only names that a registered paid or free-tier provider declares as its
 * credential are accepted (`requires` of rungs and captions providers),
 * so a request can never change server settings (VID2CONTEXT_*), base URLs,
 * model ids or bindings. Unknown names are ignored. The operator turns the
 * feature off with VID2CONTEXT_REQUEST_KEYS=0.
 */
import { type Env, type Registry, Vid2ContextError } from '@vid2context/core';

export const REQUEST_KEYS_HEADER = 'x-vid2context-keys';

/** A credential name: ends in _API_KEY, _API_TOKEN, _TOKEN or _KEY, or is an account id a keyed rung needs next to its token. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]*_(API_KEY|API_TOKEN|TOKEN|KEY|ACCOUNT_ID)$/;
/** Largest header accepted, in characters. */
const MAX_HEADER = 8192;
/** Longest single key value. */
const MAX_VALUE = 1024;
/** Visible ASCII only: no spaces, control characters or quotes that could break a header or URL. */
const VALUE = /^[\x21-\x7e]+$/;

/**
 * Names this registry accepts per request, sorted. Built from `requires`
 * of every non-local rung and every captions provider that declares one.
 */
export function requestKeyNames(registry: Registry): string[] {
  const names = new Set<string>();
  for (const p of registry.health({})) {
    for (const r of p.rungs ?? []) {
      if (r.tier === 'local') continue;
      for (const v of r.requires) names.add(v);
    }
    for (const v of p.requires ?? []) names.add(v);
  }
  return [...names].filter((n) => SECRET_NAME.test(n) && !n.startsWith('VID2CONTEXT_')).sort();
}

/**
 * Parse the header into env entries, keeping only `allowed` names. Throws
 * bad-request when the header is present but not a JSON object of strings.
 */
export function parseRequestKeys(header: string | undefined, allowed: ReadonlySet<string>): Env {
  if (header === undefined || header.trim() === '') return {};
  const bad = (why: string) =>
    new Vid2ContextError('bad-request', `The ${REQUEST_KEYS_HEADER} header ${why}.`, {
      hint: 'Send a JSON object of env-style key names to values, such as {"GROQ_API_KEY":"..."}. GET /api/v1/health lists the accepted names under requestKeys.',
    });
  if (header.length > MAX_HEADER) throw bad(`is longer than ${MAX_HEADER} characters`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    throw bad('is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('is not a JSON object');
  const out: Env = {};
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(name)) continue;
    if (typeof raw !== 'string') throw bad(`has a non-string value for ${name}`);
    const value = raw.trim();
    if (value === '') continue;
    if (value.length > MAX_VALUE || !VALUE.test(value)) throw bad(`has an invalid value for ${name}`);
    out[name] = value;
  }
  return out;
}
