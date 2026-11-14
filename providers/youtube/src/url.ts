import type { VideoRef } from '@vid2context/core';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export function videoRef(input: string, id: string): VideoRef {
  return { input, platform: 'youtube', kind: 'video', id: `youtube:${id}`, nativeId: id, url: `https://www.youtube.com/watch?v=${id}` };
}

function playlistRef(input: string, list: string): VideoRef {
  return {
    input,
    platform: 'youtube',
    kind: 'playlist',
    id: `youtube:playlist:${list}`,
    nativeId: list,
    url: `https://www.youtube.com/playlist?list=${list}`,
  };
}

function channelRef(input: string, nativeId: string, url: string): VideoRef {
  return { input, platform: 'youtube', kind: 'channel', id: `youtube:channel:${nativeId}`, nativeId, url };
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

/**
 * Recognise YouTube inputs without any network call:
 * watch, youtu.be, shorts, live, embed, /v/, m., music. and nocookie URLs,
 * bare 11-character video ids, playlist URLs and channel URLs (@handle,
 * /channel/UC..., /c/name, /user/name). A watch URL that also carries a
 * list= parameter resolves to the video; a URL with only list= is a playlist.
 */
export function matchYouTube(raw: string): VideoRef | null {
  const input = raw.trim();
  if (VIDEO_ID.test(input)) return videoRef(input, input);
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

  const [first, second] = parts;
  if (first && second && ['shorts', 'live', 'embed', 'v', 'e'].includes(first) && VIDEO_ID.test(second)) {
    return videoRef(input, second);
  }

  const list = url.searchParams.get('list');
  if (list && /^[A-Za-z0-9_-]{10,}$/.test(list)) return playlistRef(input, list);

  if (first?.startsWith('@') && first.length > 1) return channelRef(input, first, `https://www.youtube.com/${first}`);
  if (first === 'channel' && second && /^UC[A-Za-z0-9_-]{22}$/.test(second)) {
    return channelRef(input, second, `https://www.youtube.com/channel/${second}`);
  }
  if ((first === 'c' || first === 'user') && second) {
    return channelRef(input, `${first}/${second}`, `https://www.youtube.com/${first}/${second}`);
  }
  return null;
}
