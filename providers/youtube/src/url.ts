import { Vid2ContextError, type VideoRef } from '@vid2context/core';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** Channel tabs that can be listed. A channel URL without a tab lists every upload. */
export const CHANNEL_TABS = ['videos', 'shorts', 'streams', 'playlists', 'featured'] as const;
export type ChannelTab = (typeof CHANNEL_TABS)[number];

/** Default and maximum result counts for `ytsearch:` inputs. */
export const SEARCH_DEFAULT = 20;
export const SEARCH_MAX = 200;

const SEARCH_INPUT = /^ytsearch(\d*):(.*)$/is;

export function videoRef(input: string, id: string): VideoRef {
  return {
    input,
    platform: 'youtube',
    kind: 'video',
    id: `youtube:${id}`,
    nativeId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

export function playlistRef(input: string, list: string): VideoRef {
  if (list.startsWith('RD')) {
    throw new Vid2ContextError('unsupported-input', `YouTube mix ${list} cannot be listed.`, {
      hint: 'Mixes (list=RD...) are personalized and endless. Pass a regular playlist (list=PL...), a channel or a single video instead.',
    });
  }
  return {
    input,
    platform: 'youtube',
    kind: 'playlist',
    id: `youtube:playlist:${list}`,
    nativeId: list,
    url: `https://www.youtube.com/playlist?list=${list}`,
  };
}

/**
 * Channel refs: `nativeId` is the UC... id when the input carries it, else
 * `@handle`, `c:name` or `user:name`. The tab, when given, is appended to the
 * ref id after a slash (`youtube:channel:@handle/videos`) and to the URL.
 */
function channelRef(input: string, nativeId: string, path: string, tab: ChannelTab | undefined): VideoRef {
  const suffix = tab ? `/${tab}` : '';
  return {
    input,
    platform: 'youtube',
    kind: 'channel',
    id: `youtube:channel:${nativeId}${suffix}`,
    nativeId,
    url: `https://www.youtube.com/${path}${suffix}`,
  };
}

/**
 * Search refs use kind `playlist` (core has no search kind). `nativeId` is the
 * normalized input form, `ytsearch:<query>` or `ytsearch<N>:<query>`, so the
 * listing code tells a search from a playlist id by its `ytsearch` prefix.
 */
function searchRef(input: string, query: string, count: number | undefined): VideoRef {
  const nativeId = `ytsearch${count ?? ''}:${query}`;
  return {
    input,
    platform: 'youtube',
    kind: 'playlist',
    id: `youtube:${nativeId}`,
    nativeId,
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  };
}

/** The search query and count of a search ref, or null when the ref is not a search. */
export function parseSearchRef(ref: VideoRef): { query: string; count?: number } | null {
  if (ref.platform !== 'youtube' || ref.kind !== 'playlist') return null;
  const m = SEARCH_INPUT.exec(ref.nativeId);
  if (!m) return null;
  return { query: m[2] ?? '', ...(m[1] ? { count: Number(m[1]) } : {}) };
}

/** The tab recorded in a channel ref id, or undefined for all uploads. */
export function channelTabOf(ref: VideoRef): ChannelTab | undefined {
  const tab = ref.id.slice(`youtube:channel:${ref.nativeId}`.length + 1);
  return (CHANNEL_TABS as readonly string[]).includes(tab) ? (tab as ChannelTab) : undefined;
}

function matchSearch(input: string): VideoRef | null {
  const m = SEARCH_INPUT.exec(input);
  if (!m) return null;
  const query = (m[2] ?? '').trim();
  if (!query) {
    throw new Vid2ContextError('unsupported-input', 'A ytsearch: input needs a query.', {
      hint: 'Write the query after the colon, for example "ytsearch10:g wagon buyers guide".',
    });
  }
  if (!m[1]) return searchRef(input, query, undefined);
  const count = Number(m[1]);
  if (!Number.isInteger(count) || count < 1 || count > SEARCH_MAX) {
    throw new Vid2ContextError('unsupported-input', `ytsearch${m[1]}: asks for ${m[1]} results.`, {
      hint: `Use a count from 1 to ${SEARCH_MAX}, for example "ytsearch10:<query>".`,
    });
  }
  return searchRef(input, query, count);
}

function parseUrl(input: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(withScheme);
    return HOSTS.has(url.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

function tabOf(segment: string | undefined): ChannelTab | undefined {
  const lower = segment?.toLowerCase();
  return (CHANNEL_TABS as readonly string[]).includes(lower ?? '') ? (lower as ChannelTab) : undefined;
}

/**
 * Recognise YouTube inputs without any network call:
 * - videos: watch, youtu.be, shorts, live, embed, /v/, m., music. and nocookie
 *   URLs, and bare 11-character video ids;
 * - playlists: any URL with list= and no v= (a watch URL that carries both
 *   resolves to the video; `matchYouTubeList` returns its playlist).
 *   Mixes (list=RD...) throw `unsupported-input`;
 * - channels: /@handle, /channel/UC..., /c/name, /user/name, optionally
 *   followed by a tab (videos, shorts, streams, playlists, featured);
 * - search: `ytsearch:<query>`, `ytsearch<N>:<query>` and /results?search_query=.
 */
export function matchYouTube(raw: string): VideoRef | null {
  const input = raw.trim();
  if (VIDEO_ID.test(input)) return videoRef(input, input);
  const search = matchSearch(input);
  if (search) return search;
  const url = parseUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    const id = parts[0];
    return id && VIDEO_ID.test(id) ? videoRef(input, id) : null;
  }

  const v = url.searchParams.get('v');
  if (v && VIDEO_ID.test(v)) return videoRef(input, v);

  const [first, second, third] = parts;
  // /embed/videoseries?list=... embeds a playlist; "videoseries" happens to be 11 characters long.
  if (
    first &&
    second &&
    ['shorts', 'live', 'embed', 'v', 'e'].includes(first) &&
    VIDEO_ID.test(second) &&
    second !== 'videoseries'
  ) {
    return videoRef(input, second);
  }

  const list = url.searchParams.get('list');
  if (list && LIST_ID.test(list)) return playlistRef(input, list);

  if (first === 'results') {
    const query = url.searchParams.get('search_query')?.trim();
    return query ? searchRef(input, query, undefined) : null;
  }

  if (first?.startsWith('@') && first.length > 1) return channelRef(input, first, first, tabOf(second));
  if (first === 'channel' && second && CHANNEL_ID.test(second)) {
    return channelRef(input, second, `channel/${second}`, tabOf(third));
  }
  if ((first === 'c' || first === 'user') && second) {
    return channelRef(input, `${first}:${second}`, `${first}/${second}`, tabOf(third));
  }
  return null;
}

/**
 * The playlist a video URL sits in: a watch, youtu.be, shorts or embed URL
 * that carries both a video and list=. Null for every other input, and for
 * mixes (list=RD...), which are personalized and endless. No network.
 */
export function matchYouTubeList(raw: string): VideoRef | null {
  const input = raw.trim();
  if (matchYouTube(input)?.kind !== 'video') return null;
  const list = parseUrl(input)?.searchParams.get('list');
  if (!list || !LIST_ID.test(list) || list.startsWith('RD')) return null;
  return playlistRef(input, list);
}
