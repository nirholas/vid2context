/**
 * Inputs and refs. `match` is synchronous and offline, so Apple Podcasts and
 * Spotify links become refs that carry their native ids; they are resolved
 * to a feed on first use (see resolve.ts).
 *
 * Ref shapes (platform 'podcast'):
 *   feed      id podcast:feed:<sha256 of feed URL>        url the feed URL
 *   episode   id podcast:<sha256 of feed URL + item key>   url <feed URL>#item=<item key>
 *   Apple     id podcast:feed:apple-<showId> / podcast:apple-<episodeId>
 *   Spotify   id podcast:feed:spotify-<showId> / podcast:spotify-<episodeId>
 *
 * Episode refs use the feed URL plus an `#item=` fragment as their URL rather
 * than the episode web page or the enclosure: callers re-resolve `ref.url`
 * (the CLI does after `expandInput`), and only this form leads back to the
 * feed and its native transcript. The enclosure would resolve to the generic
 * media-url source and lose it. Feeds the URL heuristics do not recognise get
 * the explicit `podcast:` prefix.
 */
import type { VideoRef } from '@vid2context/core';
import { sha256Hex } from '@vid2context/provider-media-url';

export const PLATFORM = 'podcast';

/** Hosts that only serve podcast feeds. */
const FEED_HOSTS = new Set([
  'feeds.megaphone.fm',
  'feeds.simplecast.com',
  'rss.art19.com',
  'feeds.buzzsprout.com',
  'rss.buzzsprout.com',
  'feeds.transistor.fm',
  'feed.podbean.com',
  'feeds.libsyn.com',
  'rss.libsyn.com',
  'feeds.acast.com',
  'feeds.captivate.fm',
  'feeds.redcircle.com',
  'feeds.fireside.fm',
  'feeds.soundcloud.com',
  'feeds.npr.org',
  'feeds.feedburner.com',
  'feeds.blubrry.com',
  'feeds.podcastmirror.com',
  'feeds.pacific-content.com',
  'rss.com',
  'media.rss.com',
]);

/** Hosts with their own providers; never treat their URLs as podcast feeds. */
const OTHER_PLATFORMS =
  /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|x\.com|twitter\.com|bilibili\.com|tiktok\.com|instagram\.com|facebook\.com)$/i;

const MEDIA_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4v|webm|mov|mkv|m3u8|mpd)$/i;

function parseHttp(input: string): URL | null {
  if (!/^https?:\/\//i.test(input)) return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/** True when an http(s) URL looks like a podcast feed. Synchronous heuristics only. */
export function looksLikeFeed(raw: string): boolean {
  const u = parseHttp(raw.trim());
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (OTHER_PLATFORMS.test(host)) return false;
  const path = u.pathname;
  if (MEDIA_EXT.test(path)) return false;
  if (FEED_HOSTS.has(host)) return true;
  if (host === 'omnycontent.com' || host.endsWith('.omnycontent.com')) return true;
  if (host === 'anchor.fm' && /^\/s\/[^/]+\/podcast\/rss\/?$/i.test(path)) return true;
  if (/sitemap/i.test(path)) return false;
  if (/\.(rss|xml|atom)$/i.test(path)) return true;
  return /\/(feed|feeds|rss)(\/|\.|$)/i.test(path);
}

/** Canonical feed URL: fragment dropped (URL lowercases scheme and host). */
export function canonicalFeedUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

export function feedRef(input: string, feedUrl: string): VideoRef {
  const url = canonicalFeedUrl(feedUrl);
  const nativeId = sha256Hex(url);
  return { input, platform: PLATFORM, kind: 'feed', id: `${PLATFORM}:feed:${nativeId}`, nativeId, url };
}

/** The re-resolvable URL of an episode: the feed URL with an #item= fragment. */
export function episodeUrl(feedUrl: string, key: string): string {
  const url = canonicalFeedUrl(feedUrl);
  const locator = `${url}#item=${encodeURIComponent(key)}`;
  return looksLikeFeed(url) ? locator : `podcast:${locator}`;
}

export function episodeRef(input: string, feedUrl: string, key: string): VideoRef {
  const url = canonicalFeedUrl(feedUrl);
  const nativeId = sha256Hex(`${url}\n${key}`);
  return { input, platform: PLATFORM, kind: 'video', id: `${PLATFORM}:${nativeId}`, nativeId, url: episodeUrl(url, key) };
}

/** Feed URL and item key of a feed episode ref, or null for Apple, Spotify and feed refs. */
export function episodeLocator(ref: VideoRef): { feedUrl: string; key: string } | null {
  const raw = (ref.url ?? '').replace(/^podcast:/i, '');
  const hash = raw.indexOf('#item=');
  if (hash === -1) return null;
  const feedUrl = raw.slice(0, hash);
  if (!parseHttp(feedUrl)) return null;
  try {
    return { feedUrl, key: decodeURIComponent(raw.slice(hash + 6)) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Apple

const APPLE_HOSTS = /^(podcasts|itunes)\.apple\.com$/i;
const APPLE_PATH = /^\/(?:([a-z]{2})\/)?podcast\/(?:([^/]+)\/)?id(\d+)\/?$/i;

export interface AppleIds {
  showId: string;
  episodeId?: string;
  country: string;
  slug?: string;
}

export function parseAppleUrl(raw: string): AppleIds | null {
  const u = parseHttp(raw.trim());
  if (!u || !APPLE_HOSTS.test(u.hostname)) return null;
  const m = APPLE_PATH.exec(u.pathname);
  if (!m?.[3]) return null;
  const episodeId = u.searchParams.get('i') ?? undefined;
  if (episodeId !== undefined && !/^\d+$/.test(episodeId)) return null;
  return {
    showId: m[3],
    country: (m[1] ?? 'us').toLowerCase(),
    ...(m[2] ? { slug: decodeURIComponent(m[2]).toLowerCase() } : {}),
    ...(episodeId ? { episodeId } : {}),
  };
}

function appleUrl(ids: AppleIds): string {
  const slug = ids.slug ? `${encodeURIComponent(ids.slug)}/` : '';
  return `https://podcasts.apple.com/${ids.country}/podcast/${slug}id${ids.showId}${ids.episodeId ? `?i=${ids.episodeId}` : ''}`;
}

// ---------------------------------------------------------------- Spotify

const SPOTIFY_PATH = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(show|episode)\/([A-Za-z0-9]{22})\/?$/i;

export function parseSpotify(raw: string): { kind: 'show' | 'episode'; id: string } | null {
  const s = raw.trim();
  const uri = /^spotify:(show|episode):([A-Za-z0-9]{22})$/i.exec(s);
  if (uri?.[1] && uri[2]) return { kind: uri[1].toLowerCase() as 'show' | 'episode', id: uri[2] };
  const u = parseHttp(s);
  if (!u) return null;
  if (u.hostname.toLowerCase() !== 'open.spotify.com') return null;
  const m = SPOTIFY_PATH.exec(u.pathname);
  if (!m?.[1] || !m[2]) return null;
  return { kind: m[1].toLowerCase() as 'show' | 'episode', id: m[2] };
}

// ---------------------------------------------------------------- match

/** Recognise a podcast feed, feed episode, Apple Podcasts or Spotify input. Synchronous, no network. */
export function matchPodcast(raw: string): VideoRef | null {
  const input = raw.trim();
  const apple = parseAppleUrl(input);
  if (apple) {
    const url = appleUrl(apple);
    if (apple.episodeId) {
      const nativeId = `apple-${apple.episodeId}`;
      return { input, platform: PLATFORM, kind: 'video', id: `${PLATFORM}:${nativeId}`, nativeId, url };
    }
    const nativeId = `apple-${apple.showId}`;
    return { input, platform: PLATFORM, kind: 'feed', id: `${PLATFORM}:feed:${nativeId}`, nativeId, url };
  }
  const spotify = parseSpotify(input);
  if (spotify) {
    const nativeId = `spotify-${spotify.id}`;
    const url = `https://open.spotify.com/${spotify.kind}/${spotify.id}`;
    return spotify.kind === 'episode'
      ? { input, platform: PLATFORM, kind: 'video', id: `${PLATFORM}:${nativeId}`, nativeId, url }
      : { input, platform: PLATFORM, kind: 'feed', id: `${PLATFORM}:feed:${nativeId}`, nativeId, url };
  }
  const explicit = /^podcast:(https?:\/\/.+)$/i.exec(input);
  const candidate = explicit?.[1] ?? input;
  if (!explicit && !looksLikeFeed(candidate)) return null;
  const u = parseHttp(candidate);
  if (!u) return null;
  const hash = u.hash.startsWith('#item=') ? u.hash.slice(6) : '';
  if (hash) {
    try {
      return episodeRef(input, u.href, decodeURIComponent(hash));
    } catch {
      return null;
    }
  }
  return feedRef(input, u.href);
}

/** Native id kinds: 'apple-123' to { source: 'apple', id: '123' }. */
export function nativeSource(ref: VideoRef): { source: 'apple' | 'spotify'; id: string } | null {
  const m = /^(apple|spotify)-(.+)$/.exec(ref.nativeId);
  return m?.[1] && m[2] ? { source: m[1] as 'apple' | 'spotify', id: m[2] } : null;
}
