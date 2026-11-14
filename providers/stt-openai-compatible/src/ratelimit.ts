/**
 * Rate-limit headers to a retry delay, so the chain's cooldown for a rung
 * matches what the service actually asked for.
 *
 *   retry-after                      seconds or an HTTP date (RFC 9110)
 *   x-ratelimit-remaining-requests   with x-ratelimit-reset-requests ("2m59.56s", "6ms"): Groq, OpenAI, Together
 *   x-ratelimit-remaining-minute     with x-ratelimit-limit-minute: OVH and other Kong gateways (a one-minute window)
 *   x-ratelimit-reset                seconds, or a Unix timestamp
 */

/** "2m59.56s" -> 179.56, "6ms" -> 0.006, "1h" -> 3600, "12" -> 12. Undefined when unparseable. */
export function parseDuration(value: string | null | undefined): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = '';
  for (const m of v.matchAll(re)) {
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : m[2] === 'ms' ? n / 1000 : n;
    matched += m[0];
  }
  return matched === v ? total : undefined;
}

function positive(n: number | undefined): number | undefined {
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

/** Seconds to wait before this service will accept another request, or undefined when the headers do not say. */
export function retryAfterFromHeaders(headers: Headers, nowMs: number = Date.now()): number | undefined {
  const ra = headers.get('retry-after')?.trim();
  if (ra) {
    const secs = /^\d+(\.\d+)?$/.test(ra) ? Number(ra) : (Date.parse(ra) - nowMs) / 1000;
    const r = positive(secs);
    if (r) return r;
  }
  if (headers.get('x-ratelimit-remaining-requests')?.trim() === '0') {
    const r = positive(parseDuration(headers.get('x-ratelimit-reset-requests')));
    if (r) return r;
  }
  if (headers.get('x-ratelimit-remaining-minute')?.trim() === '0') return 60;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return positive(reset > 1_000_000_000 ? reset - nowMs / 1000 : reset);
  }
  return undefined;
}
