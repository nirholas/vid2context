/**
 * X (Twitter) post URL matching, without any network call.
 *
 *   x.com/<user>/status/<id>              the post's first video
 *   x.com/<user>/status/<id>/video/2      the post's second media item
 *   x.com/i/status/<id>, /i/web/status/<id>, /<user>/statuses/<id>
 *   twitter.com, mobile.twitter.com, mobile.x.com and the embed-fixer hosts
 *   fxtwitter.com, vxtwitter.com, fixupx.com, fixvx.com
 *
 * Ref ids: `x:<postId>` for the first video, `x:<postId>_v<n>` for media item n (n > 1).
 * Live broadcasts (`/i/broadcasts/...`) and Spaces are not matched; yt-dlp handles them on Node.
 */
import type { VideoRef } from '@vid2context/core';

const HOSTS = new Set([
  'x.com',
  'mobile.x.com',
  'twitter.com',
  'mobile.twitter.com',
  'm.twitter.com',
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
  'fixvx.com',
]);
const ID = /^\d{1,20}$/;

export interface XTarget {
  postId: string;
  /** 1-based position among the post's media, when the URL named one (`/video/2`). */
  media?: number;
}

export function postUrl(postId: string, media?: number): string {
  return `https://x.com/i/status/${postId}${media && media > 1 ? `/video/${media}` : ''}`;
}

export function postRef(input: string, postId: string, media?: number): VideoRef {
  const nativeId = media && media > 1 ? `${postId}_v${media}` : postId;
  return { input, platform: 'x', kind: 'video', id: `x:${nativeId}`, nativeId, url: postUrl(postId, media) };
}

function parseUrl(input: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

export function matchX(raw: string): VideoRef | null {
  const input = raw.trim();
  if (!/[./]/.test(input)) return null;
  const url = parseUrl(input);
  if (!url || !/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!HOSTS.has(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  // /<user>/status/<id>, /<user>/statuses/<id>, /i/status/<id>, /i/web/status/<id>
  const at = parts.findIndex((p, i) => (p === 'status' || p === 'statuses') && i >= 1 && i <= 2);
  if (at < 0) return null;
  if (at === 2 && !(parts[0] === 'i' && parts[1] === 'web')) return null;
  const postId = parts[at + 1];
  if (!postId || !ID.test(postId)) return null;
  const kind = parts[at + 2];
  const n = parts[at + 3];
  const media = (kind === 'video' || kind === 'photo') && n && /^[1-4]$/.test(n) ? Number(n) : undefined;
  return postRef(input, postId, media);
}

export function parseRef(ref: VideoRef): XTarget | null {
  const m = /^(\d{1,20})(?:_v([1-4]))?$/.exec(ref.nativeId);
  if (!m?.[1]) return null;
  return m[2] ? { postId: m[1], media: Number(m[2]) } : { postId: m[1] };
}
