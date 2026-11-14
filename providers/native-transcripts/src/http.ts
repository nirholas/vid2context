import { type Ctx, fetchWithTimeout } from '@vid2context/core';

export interface TextResponse {
  status: number;
  url: string;
  contentType: string;
  body: string;
}

const TIMEOUT_MS = 20_000;
const HEADERS = { accept: 'application/json, text/html;q=0.9, */*;q=0.5', 'user-agent': 'vid2context' };

/**
 * Responses are cached per Ctx, so getMetadata and getCaptions on the same
 * request share one fetch of a player config or share page. A new Ctx (one
 * per CLI run, HTTP request or test) starts empty.
 */
const cache = new WeakMap<Ctx, Map<string, Promise<TextResponse>>>();

/** GET a URL as text through ctx.fetch, without throwing on non-2xx. Concurrent and repeat calls share one request. */
export function getText(ctx: Ctx, url: string): Promise<TextResponse> {
  let perCtx = cache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    cache.set(ctx, perCtx);
  }
  const hit = perCtx.get(url);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetchWithTimeout(ctx, url, { headers: HEADERS }, TIMEOUT_MS);
    return { status: res.status, url, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
  })();
  perCtx.set(url, p);
  p.catch(() => perCtx.delete(url));
  return p;
}

/** Parse JSON, returning undefined instead of throwing on bad input. */
export function tryJson<T>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

/** Normalize a language tag: 'en-x-autogen' -> 'en', 'es-MX' stays. */
export function baseTag(tag: string): string {
  return tag.replace(/-x-.*$/i, '');
}

/** True when tag `have` satisfies a request for `want` ('en' accepts 'en-US'; 'en-US' accepts only 'en-US'). */
export function langMatches(have: string, want: string): boolean {
  const h = baseTag(have).toLowerCase();
  const w = want.toLowerCase();
  return h === w || h.split('-')[0] === w;
}
