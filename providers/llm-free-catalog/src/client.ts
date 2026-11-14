/**
 * A thin wrapper around the foundation's OpenAI-compatible client
 * (`chatWith` from @vid2context/provider-llm-openai-compatible). It adds what
 * some free lanes need and the foundation client does not do itself:
 *
 *   - extra request headers (OpenRouter's attribution headers),
 *   - per-model output caps and per-service temperature ranges,
 *   - a cooldown hint read from the rate-limit headers services send next to
 *     a 429 (`ratelimit-reset`, `x-ratelimit-reset-*`), when `Retry-After` is
 *     missing.
 *
 * The wrapper never builds a second request or parses the answer itself: the
 * body still comes from `buildBody` and the answer from `answerText`, so
 * reasoning fields and <think> blocks are stripped the same way everywhere.
 */
import { type ChatRequest, type ChatResult, type Ctx, Vid2ContextError } from '@vid2context/core';
import { chatWith } from '@vid2context/provider-llm-openai-compatible';

/** The foundation client's endpoint type (its index exports the function, not the type). */
type ChatEndpoint = Parameters<typeof chatWith>[0];

export interface LaneLimits {
  /** Largest max_tokens the model accepts; larger requests are clamped. */
  maxOutputTokens?: number;
  /** Sent when the caller gives no maxTokens (Workers AI otherwise stops at a small default). */
  defaultMaxTokens?: number;
  /** Accepted temperature range; values outside it are clamped. */
  temperature?: { min: number; max: number };
}

export interface CatalogEndpoint extends ChatEndpoint {
  headers?: Record<string, string>;
  limits?: LaneLimits;
}

/** Seconds, from a duration like '6s', '1m30s', '2m59.56s', '120ms', or a bare number of seconds. */
function parseDuration(value: string): number | undefined {
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const m of v.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    total += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : unit === 's' ? n : n / 1000;
  }
  return matched ? total : undefined;
}

const MAX_WAIT_SEC = 3600;

/**
 * Seconds until a rate limit resets, from the headers a service sent with its
 * 429. Reads Retry-After (seconds or an HTTP date), the IETF `ratelimit-reset`
 * (seconds), OpenRouter-style `x-ratelimit-reset` (epoch seconds or
 * milliseconds) and Groq-style `x-ratelimit-reset-requests` / `-tokens`
 * durations. Returns the longest wait found, capped at one hour, or undefined.
 */
export function retryAfterFromHeaders(headers: Headers, nowMs: number = Date.now()): number | undefined {
  const waits: number[] = [];
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) waits.push(n);
    else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) waits.push((at - nowMs) / 1000);
    }
  }
  const reset = headers.get('ratelimit-reset');
  if (reset && Number.isFinite(Number(reset))) waits.push(Number(reset));
  const xReset = headers.get('x-ratelimit-reset');
  if (xReset) {
    const n = Number(xReset);
    if (Number.isFinite(n)) {
      // Epoch milliseconds, epoch seconds, or a delta in seconds.
      if (n > 1e12) waits.push((n - nowMs) / 1000);
      else if (n > 1e9) waits.push(n - nowMs / 1000);
      else waits.push(n);
    } else {
      const d = parseDuration(xReset);
      if (d !== undefined) waits.push(d);
    }
  }
  for (const name of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const v = headers.get(name);
    const d = v ? parseDuration(v) : undefined;
    if (d !== undefined) waits.push(d);
  }
  const positive = waits.filter((w) => Number.isFinite(w) && w > 0);
  if (positive.length === 0) return undefined;
  return Math.min(Math.ceil(Math.max(...positive)), MAX_WAIT_SEC);
}

/** Apply the lane's output cap and temperature range to a request. */
export function limitRequest(req: ChatRequest, limits: LaneLimits | undefined): ChatRequest {
  if (!limits) return req;
  const out: ChatRequest = { ...req };
  if (out.maxTokens === undefined && limits.defaultMaxTokens !== undefined) out.maxTokens = limits.defaultMaxTokens;
  if (out.maxTokens !== undefined && limits.maxOutputTokens !== undefined) {
    out.maxTokens = Math.min(out.maxTokens, limits.maxOutputTokens);
  }
  if (out.temperature !== undefined && limits.temperature) {
    out.temperature = Math.min(Math.max(out.temperature, limits.temperature.min), limits.temperature.max);
  }
  return out;
}

/**
 * Send one chat request through the foundation client. A wrapped `ctx.fetch`
 * adds the endpoint's extra headers and keeps the last response's headers, so
 * a rate-limited error without Retry-After still carries `retryAfterSec`.
 */
export async function chatVia(ep: CatalogEndpoint, req: ChatRequest, ctx: Ctx): Promise<ChatResult> {
  let lastHeaders: Headers | undefined;
  const extra = ep.headers;
  const fetchThrough: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    const res = await ctx.fetch(input, { ...init, headers });
    lastHeaders = res.headers;
    return res;
  };
  const inner: Ctx = { ...ctx, fetch: fetchThrough };
  try {
    return await chatWith(ep, limitRequest(req, ep.limits), inner);
  } catch (err) {
    if (err instanceof Vid2ContextError && err.code === 'rate-limited' && err.retryAfterSec === undefined && lastHeaders) {
      const retryAfterSec = retryAfterFromHeaders(lastHeaders);
      if (retryAfterSec !== undefined) {
        throw new Vid2ContextError(err.code, err.message, { hint: err.hint, status: err.status, retryAfterSec, cause: err });
      }
    }
    throw err;
  }
}
