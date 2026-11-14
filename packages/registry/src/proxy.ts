/**
 * A fetch that sends YouTube traffic, and only YouTube traffic, through an
 * HTTP(S) proxy. Node only.
 *
 *   YOUTUBE_PROXY  one proxy URL, or several separated by commas, for example
 *                  http://user:pass@p.webshare.io:80 (rotating residential)
 *                  or http://192.168.1.20:3128 (a proxy on your home network)
 *
 * Why: YouTube refuses caption downloads from most cloud IPs (timedtext
 * answered HTTP 429 to a GCP VM on 2026-11-14 while the player still worked).
 * Routing every request of the process through a proxy (NODE_USE_ENV_PROXY)
 * also sends LLM, STT and storage calls through it, which is slow, costs proxy
 * bandwidth and leaks keys to the proxy operator. This wrapper picks the proxy
 * per request by host instead.
 *
 * Several proxies rotate per request. Every proxied request asks for a new
 * connection (reset), so a rotating gateway hands out a new exit IP each time
 * and a retry after a block does not reuse the flagged address.
 *
 * The proxy URL can hold credentials, so it is never logged; logs and errors
 * name the proxy host only.
 */
import type { Env } from '@vid2context/core';
import { type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';

/** Hosts whose requests go through YOUTUBE_PROXY: the site, the API, captions and media. */
const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com', 'youtubei.googleapis.com'];

export function isYouTubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return YOUTUBE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Parse YOUTUBE_PROXY into URLs. Throws a plain Error naming the bad entry's position, never its value. */
export function parseProxyList(raw: string | undefined): URL[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => {
      let url: URL;
      try {
        url = new URL(s);
      } catch {
        throw new Error(`YOUTUBE_PROXY entry ${i + 1} is not a URL. Use http://host:port or http://user:pass@host:port.`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(
          `YOUTUBE_PROXY entry ${i + 1} uses ${url.protocol}; only http:// and https:// proxies are supported (no SOCKS).`,
        );
      }
      return url;
    });
}

/** The proxy host for logs: never the credentials. */
export const proxyLabel = (url: URL): string => url.host;

function agentFor(url: URL): Dispatcher {
  // A new connection per request, so rotating gateways change the exit IP and a flagged one is not reused.
  return new ProxyAgent({ uri: url.href, keepAliveTimeout: 1 }).compose(
    (dispatch) => (opts, handler) => dispatch({ ...opts, reset: true }, handler),
  );
}

function hostOf(input: Parameters<typeof fetch>[0]): string | undefined {
  try {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Wrap `base` so YouTube requests go through the proxies in env.YOUTUBE_PROXY
 * (round robin). Returns `base` unchanged when YOUTUBE_PROXY is not set.
 */
export function youtubeProxyFetch(env: Env, base: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  const proxies = parseProxyList(env.YOUTUBE_PROXY);
  if (proxies.length === 0) return base;
  const agents = proxies.map(agentFor);
  let next = 0;
  const proxied = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const host = hostOf(input);
    if (!host || !isYouTubeHost(host)) return base(input, init);
    const dispatcher = agents[next % agents.length] as Dispatcher;
    next++;
    // undici's own fetch, so the dispatcher always matches the fetch implementation
    // (Node 22 bundles undici 6, while this package depends on undici 7).
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : input instanceof URL ? input.href : String(input);
    return undiciFetch(url, {
      ...(req ? { method: req.method, headers: req.headers, body: req.body, duplex: 'half' } : {}),
      ...(init as Record<string, unknown>),
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  };
  return proxied as typeof fetch;
}
