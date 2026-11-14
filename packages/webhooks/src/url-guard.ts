/**
 * SSRF guard for webhook target URLs. A webhook makes this server send
 * requests to a URL a caller chose, so without a guard anyone who can
 * register a hook could make it probe the private network or a cloud
 * metadata endpoint.
 *
 * The default path is the core URL policy from item 10 (`checkUrl` in
 * packages/core/src/security), restricted to `https:`: no credentials in the
 * URL; loopback, private, link-local, CGNAT, multicast, reserved and
 * metadata addresses refused as literals and, when a resolver is available,
 * in DNS answers; local-only names (localhost, .local, .internal, single
 * labels) refused. The resolver is the one registered with
 * `setHostResolver`, else Node's dns.lookup on Node; Workers has no DNS API,
 * so there only literal and name checks apply.
 *
 * With `VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL=1`, `http:` and hosts on loopback or
 * private networks are allowed (a self-hosted n8n on this machine, in Docker
 * or on the LAN). Link-local and cloud metadata addresses stay refused even
 * then, as literals and in DNS answers.
 *
 * Known limit: the address is checked, then fetch resolves the name again,
 * so a DNS server that answers differently the second time (DNS rebinding)
 * is not stopped. Redirects are never followed, which closes the other
 * common bypass.
 */
import { type Ctx, checkUrl, getHostResolver, Vid2ContextError } from '@vid2context/core';

export type HostClass = 'public' | 'loopback' | 'private' | 'link-local' | 'reserved' | 'metadata';

/** Returns every address a hostname resolves to. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export interface UrlGuardOptions {
  /** Allow http: and loopback or private hosts. Default: `VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL=1` in ctx.env. */
  allowLocal?: boolean;
  /** Resolve hostnames. Default: Node's dns.lookup on Node, none elsewhere. `null` turns resolution off. */
  resolve?: HostResolver | null;
}

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);
const METADATA_IPS = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254', 'fd00:ec2::23']);

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** Parses an IPv6 address (no brackets; a zone id is ignored) into eight 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let host = input.toLowerCase();
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(host) || !host.includes(':')) return null;
  const lastColon = host.lastIndexOf(':');
  const last = host.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    host = `${host.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string): number[] =>
    s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function classifyV4(p: number[]): HostClass {
  const [a = 0, b = 0, c = 0] = p;
  const ip = p.join('.');
  if (METADATA_IPS.has(ip)) return 'metadata';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT
  if (a === 169 && b === 254) return 'link-local';
  if (a === 0) return 'reserved';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a === 198 && b === 51 && c === 100) return 'reserved';
  if (a === 203 && b === 0 && c === 113) return 'reserved';
  if (a >= 224) return 'reserved'; // multicast, 240/4, broadcast
  return 'public';
}

function v4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function classifyV6(g: number[]): HostClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const canonical = g.map((x) => x.toString(16)).join(':');
  for (const m of METADATA_IPS) {
    const parsed = m.includes(':') ? parseIPv6(m) : null;
    if (parsed && parsed.map((x) => x.toString(16)).join(':') === canonical) return 'metadata';
  }
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && g5 === 0 && g6 === 0 && g7 === 0) return 'reserved'; // ::
  if (zeroPrefix && g5 === 0 && g6 === 0 && g7 === 1) return 'loopback'; // ::1
  if (zeroPrefix && g5 === 0xffff) return classifyV4(v4FromGroups(g6, g7)); // IPv4-mapped
  if (zeroPrefix && g5 === 0) return classifyV4(v4FromGroups(g6, g7)); // IPv4-compatible (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b) return classifyV4(v4FromGroups(g6, g7)); // NAT64
  if (g0 === 0x2002) return classifyV4(v4FromGroups(g1, g2)); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((g0 & 0xffc0) === 0xfec0) return 'reserved'; // deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return 'reserved'; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved'; // documentation
  if (g0 === 0x2001 && g1 === 0) return 'reserved'; // Teredo
  return 'public';
}

/** Classifies an IP literal, or returns null when `ip` is not one. */
export function classifyIp(ip: string): HostClass | null {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v4 = parseIPv4(bare);
  if (v4) return classifyV4(v4);
  const v6 = parseIPv6(bare);
  return v6 ? classifyV6(v6) : null;
}

function allowed(cls: HostClass, allowLocal: boolean): boolean {
  if (cls === 'public') return true;
  return allowLocal && (cls === 'loopback' || cls === 'private');
}

function reject(url: string, why: string, allowLocal: boolean): Vid2ContextError {
  return new Vid2ContextError('bad-request', `Webhook URL refused: ${url} (${why}).`, {
    hint: allowLocal
      ? 'Use a public https URL, or a host on this machine or your private network. Link-local and cloud metadata addresses are always refused.'
      : 'Use a public https URL. To deliver to this machine or your private network (a self-hosted n8n, for example), set VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL=1 on the vid2context server.',
  });
}

/**
 * The resolver to use: the one registered with core's setHostResolver, else
 * Node's dns.lookup when running on Node. The module name is a variable on
 * purpose: bundlers for Workers and the browser then leave the import alone
 * instead of failing on a Node built-in that never runs there.
 */
async function defaultResolver(ctx: Ctx): Promise<HostResolver | null> {
  const registered = getHostResolver();
  if (registered) return registered;
  if (ctx.runtime !== 'node') return null;
  const name = 'node:dns';
  const dns = (await import(/* @vite-ignore */ name)) as typeof import('node:dns');
  return async (hostname) => (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
}

export function allowLocalFromEnv(ctx: Ctx): boolean {
  return ['1', 'true', 'yes'].includes((ctx.env.VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL ?? '').toLowerCase());
}

/**
 * Validates a webhook target and returns it parsed. Throws a `bad-request`
 * Vid2ContextError with a hint when the URL is refused.
 */
export async function checkWebhookUrl(raw: string, ctx: Ctx, opts: UrlGuardOptions = {}): Promise<URL> {
  const allowLocal = opts.allowLocal ?? allowLocalFromEnv(ctx);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Vid2ContextError('bad-request', `Webhook URL is not a valid absolute URL: ${raw.slice(0, 200)}`, {
      hint: 'Pass a full URL such as https://example.com/hook.',
    });
  }
  const shown = `${url.protocol}//${url.host}`;
  if (raw.length > 2048) throw reject(shown, 'longer than 2048 characters', allowLocal);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLocal)) {
    throw reject(shown, `${url.protocol} is not allowed, use https:`, allowLocal);
  }
  const resolve = opts.resolve === undefined ? await defaultResolver(ctx) : opts.resolve;

  if (!allowLocal) {
    // Item 10's policy does the work: literals, local names, metadata hosts and DNS answers.
    const check = await checkUrl(url, { protocols: ['https:'], ...(resolve ? { resolve } : {}) });
    if (!check.ok) throw reject(shown, check.reason, allowLocal);
    return check.url;
  }

  // Local opt-in: the core policy with private hosts allowed still refuses
  // credentials and metadata hosts; link-local and metadata addresses are
  // refused here on top, as literals and in DNS answers.
  const check = await checkUrl(url, { protocols: ['http:', 'https:'], allowPrivate: true });
  if (!check.ok) throw reject(shown, check.reason, allowLocal);
  const host = url.hostname.replace(/\.$/, '');
  const literal = classifyIp(host);
  if (literal) {
    if (!allowed(literal, allowLocal)) throw reject(shown, `${host} is a ${literal} address`, allowLocal);
    return url;
  }
  if (METADATA_HOSTS.has(host)) throw reject(shown, `${host} is a cloud metadata endpoint`, allowLocal);
  if (!resolve || host === 'localhost' || host.endsWith('.localhost')) return url;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    throw new Vid2ContextError('bad-request', `Webhook host does not resolve: ${host}`, {
      hint: 'Check the hostname for typos and that it resolves from the vid2context server.',
      cause: err,
    });
  }
  if (addresses.length === 0) throw reject(shown, `${host} resolved to no addresses`, allowLocal);
  for (const address of addresses) {
    const cls = classifyIp(address) ?? 'reserved';
    if (!allowed(cls, allowLocal)) throw reject(shown, `${host} resolves to ${address}, a ${cls} address`, allowLocal);
  }
  return url;
}
