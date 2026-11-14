/**
 * URL policy: decides whether vid2context may fetch a URL on someone's behalf.
 * Runtime-neutral, so DNS checks need a resolver injected by the caller
 * (Node surfaces pass `node:dns/promises`, see docs/security/hardening.md).
 */
import { blockedAddress, isIpLiteral } from './ip.ts';

/** Returns every address a hostname resolves to. Node: `(h) => lookup(h, { all: true }).then((a) => a.map((x) => x.address))`. */
export type HostResolver = (host: string) => Promise<string[]>;

export interface UrlPolicy {
  /** Allowed schemes, with the colon. Default `['http:', 'https:']`. */
  protocols?: string[];
  /** When set, only these ports are allowed (the scheme's default port counts as that number). */
  allowPorts?: number[];
  /** Allow loopback, private, link-local and single-label hosts. For local use only; metadata hosts stay blocked. */
  allowPrivate?: boolean;
  /** Exact `host` or `host:port` values allowed even when private (for example a local Ollama at `127.0.0.1:11434`). */
  allowHosts?: string[];
  /** Resolve the hostname and refuse when any answer is a blocked address (DNS rebinding and wildcard DNS such as nip.io). */
  resolve?: HostResolver;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Hostnames that serve cloud instance metadata or credentials. Blocked even with `allowPrivate`. */
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.packet.net',
  'metadata.platformequinix.com',
  'metadata.tencentyun.com',
  'rancher-metadata',
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  '[fd00:ec2::254]',
]);

/** Suffixes that only ever name hosts on the local machine or network. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp'];

let defaultResolver: HostResolver | undefined;

/**
 * Register the resolver used when a policy has none. Node entry points call
 * this once at startup with a `node:dns/promises` lookup so every `checkUrl`,
 * `safeFetch` and public-mode input check also validates DNS answers.
 */
export function setHostResolver(resolver: HostResolver | undefined): void {
  defaultResolver = resolver;
}

/** The resolver registered with `setHostResolver`, if any. */
export function getHostResolver(): HostResolver | undefined {
  return defaultResolver;
}

const DEFAULT_PORT: Record<string, number> = { 'http:': 80, 'https:': 443 };

function hostAllowed(url: URL, host: string, policy: UrlPolicy): boolean {
  if (!policy.allowHosts?.length) return false;
  const port = url.port || String(DEFAULT_PORT[url.protocol] ?? '');
  return policy.allowHosts.some((h) => {
    const want = h.toLowerCase();
    return want === host || want === `${host}:${port}` || want === url.host.toLowerCase();
  });
}

/** Static checks only (no DNS). Used where a synchronous answer is needed, such as the public-mode input check. */
export function checkUrlSync(input: string | URL, policy: UrlPolicy = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  const protocols = policy.protocols ?? ['http:', 'https:'];
  if (!protocols.includes(url.protocol)) return { ok: false, reason: `scheme ${url.protocol} is not allowed` };
  if (url.username || url.password) return { ok: false, reason: 'credentials in the URL are not allowed' };
  // WHATWG URL lowercases, converts IDN to punycode and normalizes numeric IPv4 forms.
  let host = url.hostname.toLowerCase();
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return { ok: false, reason: 'the URL has no host' };
  if (policy.allowPorts?.length) {
    const port = url.port ? Number(url.port) : DEFAULT_PORT[url.protocol];
    if (port === undefined || !policy.allowPorts.includes(port)) return { ok: false, reason: `port ${port ?? '(none)'} is not allowed` };
  }
  const exempt = hostAllowed(url, host, policy);
  if (!exempt && METADATA_HOSTS.has(host)) return { ok: false, reason: `${host} is a cloud metadata endpoint` };
  const literal = isIpLiteral(host);
  if (!literal && !/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/.test(host)) {
    return { ok: false, reason: `host "${host}" contains characters that are not valid in a hostname` };
  }
  if (exempt || policy.allowPrivate) return { ok: true, url };
  if (literal) {
    const why = blockedAddress(host);
    if (why) return { ok: false, reason: `${host} is a ${why} address` };
    return { ok: true, url };
  }
  if (host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: `${host} names a local host` };
  }
  if (!host.includes('.')) return { ok: false, reason: `single-label host "${host}" can resolve to an internal machine` };
  return { ok: true, url };
}

/**
 * Check a URL against the policy. When a resolver is available (the policy's
 * own, or the one registered with `setHostResolver`), every address the host
 * resolves to is checked too. A failing lookup is refused.
 */
export async function checkUrl(input: string | URL, policy: UrlPolicy = {}): Promise<UrlCheck> {
  const first = checkUrlSync(input, policy);
  if (!first.ok) return first;
  const url = first.url;
  let host = url.hostname.toLowerCase();
  while (host.endsWith('.')) host = host.slice(0, -1);
  const resolve = policy.resolve ?? defaultResolver;
  if (!resolve || policy.allowPrivate || isIpLiteral(host) || hostAllowed(url, host, policy)) return first;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    return { ok: false, reason: `could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} resolved to no addresses` };
  for (const a of addresses) {
    const why = blockedAddress(a);
    if (why) return { ok: false, reason: `${host} resolves to ${a}, a ${why} address` };
  }
  return first;
}
