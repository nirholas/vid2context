/**
 * safeFetch: fetch a URL a user gave us without letting it reach the server's
 * own network. Every redirect hop is re-checked against the URL policy, the
 * body is capped while streaming, and the request has a timeout combined with
 * the context's abort signal.
 */
import { Vid2ContextError } from '../errors.ts';
import type { Ctx } from '../types.ts';
import { limits } from './limits.ts';
import { checkUrl, type UrlPolicy } from './url.ts';

export interface SafeFetchOptions {
  /** Abort and throw `too-large` once the body exceeds this many bytes. */
  maxBytes: number;
  /** Default 5. */
  maxRedirects?: number;
  /** Whole-request timeout including redirects and body. Default `limits(ctx.env).fetchTimeoutMs`. */
  timeoutMs?: number;
  /** URL policy for every hop. Default: public http(s) only. */
  policy?: UrlPolicy;
  /** Allowed Content-Type prefixes (`audio/`, `application/rss+xml`). When set, anything else is refused. */
  accept?: string[];
  /** GET (default) or HEAD. Bodies are not supported, so redirects never replay data. */
  method?: 'GET' | 'HEAD';
  /** Request headers. Authorization and Cookie are dropped when a redirect leaves the original origin. */
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  /** Every URL fetched, in order. */
  hops: string[];
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

function refused(url: string, reason: string, hop: number): Vid2ContextError {
  return new Vid2ContextError(
    'unsupported-input',
    hop === 0 ? `Refused to fetch ${url}: ${reason}.` : `Refused redirect ${hop} to ${url}: ${reason}.`,
    { hint: 'Only public http(s) addresses can be fetched. Pass a public URL.' },
  );
}

function tooLarge(maxBytes: number): Vid2ContextError {
  return new Vid2ContextError('too-large', `The response is larger than ${maxBytes} bytes.`, {
    hint: 'Use a smaller file, or raise the limit for this deployment (see docs/security/hardening.md).',
  });
}

async function readCapped(res: Response, maxBytes: number, abort: () => void): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      abort();
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Fetch `url` through `ctx.fetch` with SSRF protection. Throws
 * `unsupported-input` when any hop is refused by the policy, `too-large` past
 * `maxBytes`, `timeout` when the time runs out, and `upstream` for too many
 * redirects or a refused Content-Type. Non-2xx statuses are returned, not thrown.
 *
 * Browsers hide redirect targets from `redirect: 'manual'` (an opaque
 * response), so there a redirect is reported as `upstream`.
 */
export async function safeFetch(ctx: Ctx, url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? limits(ctx.env).fetchTimeoutMs;
  const controller = new AbortController();
  const signals = [controller.signal, AbortSignal.timeout(timeoutMs), ctx.signal].filter((s): s is AbortSignal => Boolean(s));
  const signal = AbortSignal.any(signals);
  const hops: string[] = [];
  let headers = { ...(opts.headers ?? {}) };
  let current = url;
  let origin: string | undefined;

  try {
    for (let hop = 0; ; hop++) {
      const check = await checkUrl(current, opts.policy);
      if (!check.ok) throw refused(current, check.reason, hop);
      const target = check.url;
      if (origin !== undefined && target.origin !== origin) {
        headers = Object.fromEntries(
          Object.entries(headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k)),
        );
      }
      origin ??= target.origin;
      hops.push(target.href);
      const res = await ctx.fetch(target.href, { method: opts.method ?? 'GET', headers, redirect: 'manual', signal });

      if (res.type === 'opaqueredirect' || (REDIRECT.has(res.status) && res.headers.has('location'))) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location) {
          throw new Vid2ContextError('upstream', `${target.href} redirected, but this runtime hides the target.`, {
            hint: 'Fetch this URL from a server-side surface (Node or Workers), where redirects can be checked.',
          });
        }
        if (hop >= maxRedirects) {
          throw new Vid2ContextError('upstream', `More than ${maxRedirects} redirects starting at ${url}.`, {
            hint: 'The address redirects in a loop or through too many hosts. Pass the final URL directly.',
          });
        }
        current = new URL(location, target).href;
        continue;
      }

      if (opts.accept?.length) {
        const type = (res.headers.get('content-type') ?? '').toLowerCase();
        if (!opts.accept.some((a) => type.startsWith(a.toLowerCase()))) {
          await res.body?.cancel().catch(() => undefined);
          throw new Vid2ContextError('upstream', `${target.href} returned Content-Type "${type || 'none'}".`, {
            hint: `Expected ${opts.accept.join(' or ')}. Check that the URL points at the right kind of file.`,
          });
        }
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        controller.abort();
        await res.body?.cancel().catch(() => undefined);
        throw tooLarge(opts.maxBytes);
      }
      const bytes = await readCapped(res, opts.maxBytes, () => controller.abort());
      return { url: target.href, status: res.status, headers: res.headers, bytes, hops };
    }
  } catch (err) {
    if (err instanceof Vid2ContextError) throw err;
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Vid2ContextError('timeout', `Fetching ${url} took longer than ${timeoutMs} ms.`, {
        hint: 'Try again, or raise VID2CONTEXT_FETCH_TIMEOUT_MS.',
        cause: err,
      });
    }
    throw err;
  }
}
