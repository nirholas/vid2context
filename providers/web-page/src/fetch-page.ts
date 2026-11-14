/**
 * Fetch a web page safely: http(s) only, no private or loopback hosts (checked
 * again on every redirect hop), at most 5 redirects, a timeout per hop, and at
 * most 2 MB of HTML read (a longer page is cut at the cap and parsed as far as
 * it goes). The host check looks at the hostname only, so it cannot catch a
 * public name that resolves to a private address (DNS rebinding); the shared
 * hardened fetch of roadmap item 10 covers that.
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';

export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 20_000;

export interface Page {
  /** Final URL after redirects. */
  url: URL;
  html: string;
  status: number;
  truncated: boolean;
}

function ipv4Private(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Expand an IPv6 literal (WHATWG URL form, already compressed and lowercased) to 8 groups. */
function ipv6Groups(host: string): number[] | null {
  let h = host;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (v4?.[1]) {
    const p = parseIpv4(v4[1]);
    if (!p) return null;
    h = `${h.slice(0, -v4[1].length)}${((p[0] ?? 0) * 256 + (p[1] ?? 0)).toString(16)}:${((p[2] ?? 0) * 256 + (p[3] ?? 0)).toString(16)}`;
  }
  const [head = '', tail] = h.split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - a.length - b.length;
  if (fill < 0) return null;
  const groups = [...a, ...Array<string>(fill).fill('0'), ...b].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * True for hosts that point at this machine or a private network: localhost and
 * *.localhost, *.local, *.internal, *.home.arpa, single-label names, and IP
 * literals in loopback, private, link-local, CGNAT, multicast or reserved ranges
 * (IPv4-mapped and NAT64 IPv6 forms included).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) {
    const g = ipv6Groups(host.slice(1, -1));
    if (!g) return true;
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
    const embeddedV4 = (): boolean => ipv4Private(g6 >> 8, g6 & 0xff);
    if (g.every((x) => x === 0)) return true; // ::
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return embeddedV4(); // mapped or compatible
    if (g0 === 0x64 && g1 === 0xff9b) return embeddedV4(); // NAT64
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g0 & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  const v4 = parseIpv4(host);
  if (v4) return ipv4Private(v4[0] ?? 0, v4[1] ?? 0);
  if (!host.includes('.')) return true;
  return /(^|\.)(localhost|local|internal|home\.arpa)$/.test(host);
}

/** Throw unless `url` is an http(s) URL on a public host. */
export function assertPublicUrl(url: URL): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Vid2ContextError('bad-request', `Only http and https pages can be read, not ${url.protocol}`, {
      hint: 'Pass a web page URL that starts with https://.',
    });
  }
  if (url.username || url.password) {
    throw new Vid2ContextError('bad-request', 'Page URLs with a user name or password are refused.', {
      hint: 'Remove the credentials from the URL.',
    });
  }
  if (isPrivateHost(url.hostname)) {
    throw new Vid2ContextError('bad-request', `Refusing to fetch ${url.hostname}: it is a local or private address.`, {
      hint: 'Only public web pages can be read. For a local video file, pass its path instead.',
    });
  }
}

async function readCapped(res: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - size));
      size = cap;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { bytes: out, truncated };
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)\b/i;

/** Fetch an HTML page under the limits described above. */
export async function fetchPage(input: string, ctx: Ctx, opts: { maxBytes?: number } = {}): Promise<Page> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Vid2ContextError('bad-request', `Not a URL: ${input.slice(0, 200)}`, { hint: 'Pass a full page URL, such as https://example.com/article.' });
  }
  for (let hop = 0; ; hop++) {
    assertPublicUrl(url);
    const res = await fetchWithTimeout(
      ctx,
      url.href,
      { redirect: 'manual', headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'user-agent': 'vid2context' } },
      TIMEOUT_MS,
    );
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) {
        throw new Vid2ContextError('upstream', `More than ${MAX_REDIRECTS} redirects starting from ${input}.`, {
          hint: 'Open the page in a browser and pass the address it ends up on.',
        });
      }
      url = new URL(res.headers.get('location') ?? '', url);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      throw new Vid2ContextError('blocked', `${url.hostname} refused the request (HTTP ${res.status}).`, {
        status: res.status,
        hint: 'The site blocks automated requests or needs a login. Pass the video URL itself instead of the page.',
      });
    }
    if (!res.ok) throw await errorFromResponse(res, `web page ${url.hostname}`);
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !HTML_TYPES.test(contentType)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Vid2ContextError('unsupported-input', `${url.href} is not an HTML page (${contentType.split(';')[0]}).`, {
        hint: 'For a direct media or video link, pass it without the page: prefix.',
      });
    }
    const { bytes, truncated } = await readCapped(res, opts.maxBytes ?? MAX_HTML_BYTES);
    if (truncated) ctx.log.warn('web-page: page is larger than the cap; parsing the first part only', { url: url.href, bytes: bytes.byteLength });
    return { url, html: decode(bytes, contentType), status: res.status, truncated };
  }
}

const cache = new WeakMap<Ctx, Map<string, Promise<Page>>>();

/** fetchPage, shared per Ctx so metadata, listing and transcript calls in one request fetch a page once. */
export function cachedPage(input: string, ctx: Ctx): Promise<Page> {
  let perCtx = cache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    cache.set(ctx, perCtx);
  }
  const hit = perCtx.get(input);
  if (hit) return hit;
  const p = fetchPage(input, ctx);
  perCtx.set(input, p);
  p.catch(() => perCtx.delete(input));
  return p;
}
