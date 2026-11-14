/**
 * Bilibili's WBI request signature, required by the player endpoints
 * (/x/player/wbi/v2, /x/player/wbi/playurl). Ported from yt-dlp's
 * BilibiliBaseIE._get_wbi_key and _sign_wbi (Unlicense), which follow
 * getMixinKey() in bilibili's web player; see THIRD_PARTY_NOTICES.md.
 *
 *   1. /x/web-interface/nav returns two image URLs; their file stems joined make a 64-char string.
 *   2. The mixin key is that string reordered by MIXIN_KEY_ENC_TAB, first 32 chars.
 *   3. Add wts (unix seconds), drop the characters !'()* from values, sort by key, URL-encode.
 *   4. w_rid = md5(query + mixinKey).
 */
import { md5Hex } from './md5.ts';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37,
  48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function stem(url: string): string {
  return (url.split('/').pop() ?? '').split('.')[0] ?? '';
}

/** Mixin key from the nav response's wbi_img.img_url and sub_url. */
export function mixinKey(imgUrl: string, subUrl: string): string {
  const raw = stem(imgUrl) + stem(subUrl);
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? '')
    .join('')
    .slice(0, 32);
}

/** Signed query string (including wts and w_rid) for the given parameters. */
export function signQuery(params: Record<string, string | number>, key: string, nowSec = Math.round(Date.now() / 1000)): string {
  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...params, wts: nowSec })) all[k] = String(v).replace(/[!'()*]/g, '');
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k] as string)}`)
    .join('&');
  return `${query}&w_rid=${md5Hex(query + key)}`;
}
