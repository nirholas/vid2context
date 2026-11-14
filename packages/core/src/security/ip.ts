/**
 * IP address parsing and range checks. Pure functions, runtime-neutral.
 *
 * Inputs are expected to be already normalized by the WHATWG URL parser
 * (which turns `2130706433`, `0177.0.0.1`, `0x7f.1` and `127.1` into
 * `127.0.0.1`), but `parseIPv4` also accepts those legacy forms itself so
 * addresses that come from DNS answers or other parsers are judged the same.
 */

/** Parse an IPv4 address in dotted, short, octal, hex or single-number form. Returns the 32-bit value, or null. */
export function parseIPv4(input: string): number | null {
  const host = input.endsWith('.') ? input.slice(0, -1) : input;
  if (host === '') return null;
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : Number.parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = Number.parseInt(p, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = Number(p);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums.pop() as number;
  if (nums.some((n) => n > 255)) return null;
  if (last >= 256 ** (4 - nums.length)) return null;
  let value = last;
  nums.forEach((n, i) => {
    value += n * 256 ** (3 - i);
  });
  return value;
}

/** Parse an IPv6 address (brackets and zone ids allowed) into eight 16-bit groups, or null. */
export function parseIPv6(input: string): number[] | null {
  let host = input;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  if (!host.includes(':')) return null;
  let tail: number[] = [];
  const lastColon = host.lastIndexOf(':');
  const maybeV4 = host.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(maybeV4)) return null;
    const v4 = parseIPv4(maybeV4);
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    host = `${host.slice(0, lastColon + 1)}0:0`;
  }
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] as string);
  const rest = halves.length === 2 ? toGroups(halves[1] as string) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length) {
    groups[6] = tail[0] as number;
    groups[7] = tail[1] as number;
  }
  return groups;
}

/** IPv4 ranges that must never be fetched on behalf of a remote user. [network, prefix, label]. */
const V4_BLOCKED: [number, number, string][] = [
  [0x00000000, 8, 'unspecified (0.0.0.0/8)'],
  [0x0a000000, 8, 'private (10.0.0.0/8)'],
  [0x64400000, 10, 'carrier-grade NAT (100.64.0.0/10)'],
  [0x7f000000, 8, 'loopback (127.0.0.0/8)'],
  [0xa9fe0000, 16, 'link-local (169.254.0.0/16)'],
  [0xac100000, 12, 'private (172.16.0.0/12)'],
  [0xc0000000, 24, 'IETF reserved (192.0.0.0/24)'],
  [0xc0000200, 24, 'documentation (192.0.2.0/24)'],
  [0xc0586300, 24, '6to4 relay (192.88.99.0/24)'],
  [0xc0a80000, 16, 'private (192.168.0.0/16)'],
  [0xc6120000, 15, 'benchmarking (198.18.0.0/15)'],
  [0xc6336400, 24, 'documentation (198.51.100.0/24)'],
  [0xcb007100, 24, 'documentation (203.0.113.0/24)'],
  [0xe0000000, 4, 'multicast (224.0.0.0/4)'],
  [0xf0000000, 4, 'reserved (240.0.0.0/4)'],
];

function inV4(value: number, net: number, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  return value >= net && value < net + size;
}

/** Why an IPv4 address is blocked, or null when it is a public unicast address. */
export function blockedIPv4(value: number): string | null {
  for (const [net, prefix, label] of V4_BLOCKED) if (inV4(value, net, prefix)) return label;
  return null;
}

/** Why an IPv6 address is blocked, or null when it is a public unicast address. */
export function blockedIPv6(g: number[]): string | null {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g6 = 0, g7 = 0] = g;
  const embedded = g6 * 65536 + g7;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0) {
    if (f === 0xffff) return 'IPv4-mapped IPv6 (::ffff:0:0/96)';
    if (f === 0 && g6 === 0 && g7 === 0) return 'unspecified (::)';
    if (f === 0 && g6 === 0 && g7 === 1) return 'loopback (::1)';
    if (f === 0) return 'IPv4-compatible IPv6 (::/96)';
  }
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) return 'IPv4-translated IPv6 (::ffff:0:0:0/96)';
  if (a === 0x64 && b === 0xff9b) {
    const inner = blockedIPv4(embedded);
    if (inner || (c === 1 && d === 0)) return `NAT64 to ${inner ?? 'a local prefix (64:ff9b:1::/48)'}`;
  }
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return 'discard (100::/64)';
  if (a === 0x2001 && b === 0) return 'Teredo (2001::/32)';
  if (a === 0x2001 && b === 0xdb8) return 'documentation (2001:db8::/32)';
  if (a === 0x2002) {
    const inner = blockedIPv4(b * 65536 + c);
    if (inner) return `6to4 to ${inner}`;
  }
  if ((a & 0xfe00) === 0xfc00) return 'unique local (fc00::/7)';
  if ((a & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
  if ((a & 0xffc0) === 0xfec0) return 'site-local (fec0::/10)';
  if ((a & 0xff00) === 0xff00) return 'multicast (ff00::/8)';
  return null;
}

/** Why a literal IP address (v4 or v6, any legacy form) is blocked, or null when public or not an IP literal. */
export function blockedAddress(address: string): string | null {
  const v6 = parseIPv6(address);
  if (v6) return blockedIPv6(v6);
  const v4 = parseIPv4(address);
  if (v4 !== null) return blockedIPv4(v4);
  return null;
}

/** True when the string is an IPv4 or IPv6 literal. */
export function isIpLiteral(address: string): boolean {
  return parseIPv6(address) !== null || parseIPv4(address) !== null;
}
