/**
 * Test helpers, exported as `@vid2context/core/testing`. Runtime-neutral.
 *
 * Providers never touch global fetch, so a test injects `replayFetch` through
 * the Ctx and serves responses recorded from the real service (fixture files
 * under the package's test/fixtures/). Any request without a recorded response
 * throws, so a unit test can never reach the network by accident. Live tests
 * (gated by LIVE=1) use a real context instead.
 */
import { createContext } from './context.ts';
import type { Ctx, Env, Logger, Runtime } from './types.ts';

export interface RecordedResponse {
  status?: number;
  headers?: Record<string, string>;
  body: string | Uint8Array;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: RequestInit['body'] | undefined;
}

export interface Route {
  /** Default: any method. */
  method?: string;
  /** Exact URL, a RegExp tested against the full URL, or a predicate. */
  url: string | RegExp | ((url: URL) => boolean);
  response: RecordedResponse | ((call: RecordedCall) => RecordedResponse | Promise<RecordedResponse>);
}

export type ReplayFetch = typeof fetch & { calls: RecordedCall[] };

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function matches(route: Route, url: URL, method: string): boolean {
  if (route.method && route.method.toUpperCase() !== method) return false;
  if (typeof route.url === 'string') return route.url === url.href;
  if (route.url instanceof RegExp) return route.url.test(url.href);
  return route.url(url);
}

/** A fetch that answers only from recorded responses. Every call is kept in `.calls` for assertions. */
export function replayFetch(routes: Route[]): ReplayFetch {
  const calls: RecordedCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const call: RecordedCall = { url: url.href, method, headers: headersOf(init), body: init?.body ?? undefined };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const route = routes.find((r) => matches(r, url, method));
    if (!route) throw new Error(`replayFetch: no recorded response for ${method} ${url.href}`);
    const rec = typeof route.response === 'function' ? await route.response(call) : route.response;
    const body = typeof rec.body === 'string' ? rec.body : new Uint8Array(rec.body);
    return new Response(body, { status: rec.status ?? 200, headers: rec.headers });
  };
  return Object.assign(fn, { calls }) as ReplayFetch;
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A Ctx for unit tests: given env only (never process.env), silent logs, and a fetch you pass (default: one that rejects every call). */
export function testContext(opts: { env?: Env; fetch?: typeof fetch; runtime?: Runtime; signal?: AbortSignal } = {}): Ctx {
  return createContext({
    runtime: opts.runtime ?? 'node',
    env: opts.env ?? {},
    fetch: opts.fetch ?? replayFetch([]),
    log: silent,
    signal: opts.signal,
  });
}
