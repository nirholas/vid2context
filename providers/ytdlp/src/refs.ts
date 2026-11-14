/**
 * Turn any http(s) URL into a VideoRef, synchronously and without network.
 *
 * YouTube URLs get exactly the YouTube provider's ref (`youtube:<id>`), so the
 * cache key is the same whichever provider fetched the audio. Other URLs get:
 *   platform  a slug for the extractor yt-dlp will use, when the host makes it
 *             obvious (vimeo, tiktok, twitter, ...), else `web`
 *   nativeId  the first 16 bytes (hex) of the SHA-256 of the canonical URL
 *             (lowercased host without www., no fragment, tracking parameters
 *             dropped, remaining parameters sorted)
 * The extractor's own id is only known after a network call, and changing the
 * ref id then would break the cache lookup that happens before it, so the ref
 * stays URL-based and the extractor id is reported in metadata.extra.
 */
import { createHash } from 'node:crypto';
import type { RefKind, VideoRef } from '@vid2context/core';
import { matchYouTube } from '@vid2context/provider-youtube';

/** Host suffix -> platform slug (yt-dlp extractor family, lowercased). */
const PLATFORMS: [string, string][] = [
  ['vimeo.com', 'vimeo'],
  ['tiktok.com', 'tiktok'],
  ['twitter.com', 'twitter'],
  ['x.com', 'twitter'],
  ['instagram.com', 'instagram'],
  ['reddit.com', 'reddit'],
  ['redd.it', 'reddit'],
  ['twitch.tv', 'twitch'],
  ['loom.com', 'loom'],
  ['rumble.com', 'rumble'],
  ['dailymotion.com', 'dailymotion'],
  ['dai.ly', 'dailymotion'],
  ['facebook.com', 'facebook'],
  ['fb.watch', 'facebook'],
  ['archive.org', 'archiveorg'],
  ['soundcloud.com', 'soundcloud'],
  ['bandcamp.com', 'bandcamp'],
  ['bilibili.com', 'bilibili'],
  ['ted.com', 'ted'],
  ['streamable.com', 'streamable'],
  ['bsky.app', 'bluesky'],
  ['kick.com', 'kick'],
  ['odysee.com', 'odysee'],
  ['bitchute.com', 'bitchute'],
  ['peertube.tv', 'peertube'],
  ['nebula.tv', 'nebula'],
  ['wistia.com', 'wistia'],
  ['vidyard.com', 'vidyard'],
];

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|igshid|igsh|si|feature|ref|ref_src|ref_url|share_id|_r|t)$/i;

export function platformOf(host: string): string {
  const h = host.toLowerCase();
  for (const [suffix, slug] of PLATFORMS) if (h === suffix || h.endsWith(`.${suffix}`)) return slug;
  return 'web';
}

/** Canonical form of a URL for hashing. Returns null for anything that is not http(s). */
export function canonicalUrl(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  const kept = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(kept).toString();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function urlHash(url: URL): string {
  return createHash('sha256').update(url.href).digest('hex').slice(0, 32);
}

/** Conservative list detection from the path; anything else is a single video. */
export function kindOf(url: URL): RefKind {
  const path = url.pathname.toLowerCase();
  if (url.searchParams.has('list') || /\/(playlists?|showcase|album|sets|collections?)(\/|$)/.test(path)) return 'playlist';
  if (/^\/@[^/]+\/?$/.test(path) || /^\/(channel|user|c)\/[^/]+\/?$/.test(path) || /\/videos\/?$/.test(path)) return 'channel';
  return 'video';
}

/** Match any http(s) URL. */
export function matchUrl(raw: string): VideoRef | null {
  const input = raw.trim();
  if (!/^https?:\/\//i.test(input)) return null;
  const yt = matchYouTube(input);
  if (yt) return yt;
  const url = canonicalUrl(input);
  if (!url) return null;
  const platform = platformOf(url.hostname);
  const kind = kindOf(url);
  const nativeId = urlHash(url);
  const id = kind === 'video' ? `${platform}:${nativeId}` : `${platform}:${kind}:${nativeId}`;
  let original: string;
  try {
    original = new URL(input).href;
  } catch {
    return null;
  }
  return { input, platform, kind, id, nativeId, url: original };
}

/**
 * vimeo.com/<id> pages now need a signed-in session from many IPs, while the
 * embed player URL for the same id works without one. Returns the player URL
 * to retry with, or null when the URL is not a plain Vimeo video page.
 */
export function vimeoPlayerUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'vimeo.com') return null;
  const m = /^\/(?:channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d+)(?:\/([0-9a-f]{6,}))?\/?$/i.exec(url.pathname);
  if (!m?.[1]) return null;
  const hash = m[2] ?? url.searchParams.get('h');
  return `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ''}`;
}
