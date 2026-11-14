/**
 * Turn an embed or link URL found on a page into the input another source
 * understands: the platform's own watch URL where one exists (a YouTube embed
 * becomes a watch URL, a Twitch player URL becomes a twitch.tv/videos URL).
 * Synchronous, no network.
 */
import { matchLoom, matchVimeo, matchWistia } from '@vid2context/provider-native-transcripts';
import { matchYouTube } from '@vid2context/provider-youtube';

export interface Classified {
  input: string;
  platform: string;
}

const MEDIA_EXT = /\.(mp4|m4v|webm|mov|ogv|ogg|mkv|m3u8|mpd)$/i;

const bare = (host: string): string => host.toLowerCase().replace(/^www\./, '');

function youtube(url: URL): Classified | null {
  const host = bare(url.hostname);
  if (!/^(m\.|music\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(host)) return null;
  // /embed/videoseries?list=... is a playlist player, and its path segment happens to be 11 characters long.
  if (/^\/embed\/videoseries\/?$/.test(url.pathname)) return null;
  const ref = matchYouTube(url.href);
  return ref?.kind === 'video' && ref.url ? { input: ref.url, platform: 'youtube' } : null;
}

function fromMatcher(platform: string, match: (s: string) => { kind: string; url?: string } | null, url: URL): Classified | null {
  const ref = match(url.href);
  return ref?.kind === 'video' && ref.url ? { input: ref.url, platform } : null;
}

function dailymotion(url: URL): Classified | null {
  const host = bare(url.hostname);
  const parts = url.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (host === 'dailymotion.com') {
    if (parts[0] === 'video') id = parts[1];
    else if (parts[0] === 'embed' && parts[1] === 'video') id = parts[2];
  } else if (host === 'dai.ly') id = parts[0];
  else if (host === 'geo.dailymotion.com' && /^\/player(\/[^/]+)?\.html$/.test(url.pathname))
    id = url.searchParams.get('video') ?? undefined;
  id = id?.split('_')[0];
  return id && /^[a-z0-9]{5,}$/i.test(id) ? { input: `https://www.dailymotion.com/video/${id}`, platform: 'dailymotion' } : null;
}

function twitch(url: URL): Classified | null {
  const host = bare(url.hostname);
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'player.twitch.tv') {
    const video = url.searchParams.get('video')?.replace(/^v/, '');
    if (video && /^\d+$/.test(video)) return { input: `https://www.twitch.tv/videos/${video}`, platform: 'twitch' };
    const channel = url.searchParams.get('channel');
    if (channel && /^\w{2,25}$/.test(channel))
      return { input: `https://www.twitch.tv/${channel.toLowerCase()}`, platform: 'twitch' };
    return null;
  }
  if (host === 'clips.twitch.tv') {
    const slug = parts[0] === 'embed' ? url.searchParams.get('clip') : parts[0];
    return slug && /^[\w-]+$/.test(slug) ? { input: `https://clips.twitch.tv/${slug}`, platform: 'twitch' } : null;
  }
  if (host === 'twitch.tv' || host === 'm.twitch.tv') {
    if (parts[0] === 'videos' && parts[1] && /^\d+$/.test(parts[1]))
      return { input: `https://www.twitch.tv/videos/${parts[1]}`, platform: 'twitch' };
    if (parts[1] === 'clip' && parts[2]) return { input: `https://clips.twitch.tv/${parts[2]}`, platform: 'twitch' };
  }
  return null;
}

function rumble(url: URL): Classified | null {
  if (bare(url.hostname) !== 'rumble.com') return null;
  const embed = /^\/embed\/([a-z0-9]+)\/?$/i.exec(url.pathname);
  if (embed?.[1]) return { input: `https://rumble.com/embed/${embed[1]}/`, platform: 'rumble' };
  return /^\/v[a-z0-9]+-[^/]+\.html$/i.test(url.pathname)
    ? { input: `https://rumble.com${url.pathname}`, platform: 'rumble' }
    : null;
}

function ted(url: URL): Classified | null {
  const host = bare(url.hostname);
  if (host !== 'ted.com' && host !== 'embed.ted.com') return null;
  const m = /^\/talks\/([a-z0-9_]+)\/?$/i.exec(url.pathname);
  return m?.[1] ? { input: `https://www.ted.com/talks/${m[1]}`, platform: 'ted' } : null;
}

const CLASSIFIERS: ((url: URL) => Classified | null)[] = [
  youtube,
  (u) => fromMatcher('vimeo', matchVimeo, u),
  (u) => fromMatcher('loom', matchLoom, u),
  (u) => fromMatcher('wistia', matchWistia, u),
  dailymotion,
  twitch,
  rumble,
  ted,
];

/** A known video platform URL, normalized to that platform's watch URL, or null. */
export function classifyVideoUrl(url: URL): Classified | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  for (const c of CLASSIFIERS) {
    const hit = c(url);
    if (hit) return hit;
  }
  return null;
}

/** A direct media file URL (mp4, webm, HLS or DASH manifest, ...). */
export function isMediaFileUrl(url: URL): boolean {
  return (url.protocol === 'https:' || url.protocol === 'http:') && MEDIA_EXT.test(url.pathname);
}

/** Wistia media from a bare hashed id (the `wistia_async_<id>` class or `<wistia-player media-id>`). */
export function wistiaInput(id: string): Classified | null {
  return /^[a-z0-9]{10}$/.test(id) ? { input: `https://fast.wistia.net/embed/iframe/${id}`, platform: 'wistia' } : null;
}

/** Resolve `raw` against `base`, keeping only http(s) results. */
export function absoluteUrl(raw: string | undefined, base: URL): URL | null {
  const s = raw?.trim();
  if (!s || s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('javascript:')) return null;
  try {
    const u = new URL(s, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}
