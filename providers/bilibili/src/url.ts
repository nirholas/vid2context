/**
 * Bilibili URL matching, without any network call.
 *
 *   www.bilibili.com/video/BV1xx411c79H        part 1 (or the only part)
 *   www.bilibili.com/video/av706?p=2           part 2, canonicalised to the BV id
 *   m.bilibili.com/video/BV...                 mobile pages
 *   player.bilibili.com/player.html?bvid=...   embeds (also aid=)
 *   b23.tv/<code>                              short links, resolved later with one HEAD request
 *   BV1xx411c79H, av706                        bare ids
 *   ...?p=all                                  every part of a multi-part video, as a playlist
 *
 * Ref ids: `bilibili:BV...` for part 1, `bilibili:BV..._p<n>` for later
 * parts, `bilibili:playlist:BV...` for the list of parts and
 * `bilibili:b23:<code>` for a short link whose target is not known yet.
 */
import type { VideoRef } from '@vid2context/core';

const HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']);
const BV = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;
const AV = /^av(\d{1,16})$/i;

// av/BV conversion, the 2024 scheme used by bilibili's web player.
const XOR_CODE = 23442827791579n;
const MASK_CODE = 2251799813685247n;
const MAX_AID = 1n << 51n;
const BASE = 58n;
const ALPHABET = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';

function swap(chars: string[], a: number, b: number): void {
  const t = chars[a] as string;
  chars[a] = chars[b] as string;
  chars[b] = t;
}

/** av number to BV id. */
export function av2bv(aid: number | bigint): string {
  const chars = ['B', 'V', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0'];
  let tmp = (MAX_AID | BigInt(aid)) ^ XOR_CODE;
  for (let i = chars.length - 1; tmp > 0n; i--) {
    chars[i] = ALPHABET[Number(tmp % BASE)] as string;
    tmp /= BASE;
  }
  swap(chars, 3, 9);
  swap(chars, 4, 7);
  return chars.join('');
}

/** BV id to av number. */
export function bv2av(bvid: string): number {
  const chars = bvid.split('');
  swap(chars, 3, 9);
  swap(chars, 4, 7);
  let tmp = 0n;
  for (const c of chars.slice(3)) tmp = tmp * BASE + BigInt(ALPHABET.indexOf(c));
  return Number((tmp & MASK_CODE) ^ XOR_CODE);
}

export interface BiliTarget {
  bvid: string;
  /** 1-based part number, or 'all' for the list of parts. */
  page: number | 'all';
}

export function videoUrl(bvid: string, page = 1): string {
  return `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`;
}

export function partRef(input: string, bvid: string, page: number): VideoRef {
  const nativeId = page > 1 ? `${bvid}_p${page}` : bvid;
  return { input, platform: 'bilibili', kind: 'video', id: `bilibili:${nativeId}`, nativeId, url: videoUrl(bvid, page) };
}

function listRef(input: string, bvid: string): VideoRef {
  return {
    input,
    platform: 'bilibili',
    kind: 'playlist',
    id: `bilibili:playlist:${bvid}`,
    nativeId: bvid,
    url: `${videoUrl(bvid)}?p=all`,
  };
}

function shortRef(input: string, code: string): VideoRef {
  return {
    input,
    platform: 'bilibili',
    kind: 'video',
    id: `bilibili:b23:${code}`,
    nativeId: `b23:${code}`,
    url: `https://b23.tv/${code}`,
  };
}

/** Normalise a BV id or av number to a BV id; null when it is neither. */
export function toBvid(id: string): string | null {
  if (BV.test(id)) return id;
  const av = AV.exec(id);
  return av?.[1] ? av2bv(BigInt(av[1])) : null;
}

function refFor(input: string, id: string, p: string | null): VideoRef | null {
  const bvid = toBvid(id);
  if (!bvid) return null;
  if (p === 'all') return listRef(input, bvid);
  const page = p && /^\d{1,4}$/.test(p) ? Math.max(1, Number(p)) : 1;
  return partRef(input, bvid, page);
}

function parseUrl(input: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

export function matchBilibili(raw: string): VideoRef | null {
  const input = raw.trim();
  if (BV.test(input) || /^av\d{1,16}$/i.test(input)) return refFor(input, input, null);
  if (!/[./]/.test(input)) return null;
  const url = parseUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  const p = url.searchParams.get('p');

  if (host === 'b23.tv' || host === 'www.b23.tv') {
    const code = parts[0];
    if (!code || !/^[A-Za-z0-9]{4,16}$/.test(code)) return null;
    // b23.tv/BV... and b23.tv/av... carry the id already; anything else is a short code.
    return refFor(input, code, p) ?? shortRef(input, code);
  }
  if (host === 'player.bilibili.com' && parts[0] === 'player.html') {
    const id = url.searchParams.get('bvid') ?? (url.searchParams.get('aid') ? `av${url.searchParams.get('aid')}` : null);
    return id ? refFor(input, id, url.searchParams.get('page') ?? p) : null;
  }
  if (!HOSTS.has(host)) return null;
  if (parts[0] === 'video' && parts[1]) return refFor(input, parts[1], p);
  if (parts[0] === 'festival') {
    const bvid = url.searchParams.get('bvid');
    return bvid ? refFor(input, bvid, p) : null;
  }
  return null;
}

/** What a ref points at: a BV id and part, or a b23.tv code still to resolve. */
export function parseRef(ref: VideoRef): BiliTarget | { short: string } | null {
  if (ref.nativeId.startsWith('b23:')) return { short: ref.nativeId.slice(4) };
  if (ref.kind === 'playlist') return BV.test(ref.nativeId) ? { bvid: ref.nativeId, page: 'all' } : null;
  const m = /^(BV1[1-9A-HJ-NP-Za-km-z]{9})(?:_p(\d+))?$/.exec(ref.nativeId);
  return m?.[1] ? { bvid: m[1], page: m[2] ? Number(m[2]) : 1 } : null;
}
