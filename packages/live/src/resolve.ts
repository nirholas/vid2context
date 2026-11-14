/**
 * Turn a user input into the media playlist that carries a live stream's
 * audio. YouTube videos go through the player response's live HLS manifest;
 * any URL that serves an HLS playlist (.m3u8) is used directly. A master
 * playlist is reduced to its cheapest audio-bearing rendition or variant.
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, type Registry, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { isPlaylist, parsePlaylist, pickAudioUri } from './hls.ts';
import { matchYouTubeVideo, NOT_LIVE_HINT, youtubeLiveHls } from './youtube.ts';

export interface LiveSource {
  ref: VideoRef;
  title?: string;
  channel?: string;
  /** The media playlist to poll. */
  mediaUrl: string;
  /** The master playlist it came from, when there was one. */
  masterUrl?: string;
  /** Epoch ms when the playlist URLs expire (YouTube signs them for about six hours). */
  expiresAtMs?: number;
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function looksLikeHls(url: string): boolean {
  try {
    return /\.m3u8?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A stable ref for a bare HLS URL: platform `hls`, id from the URL without its (often signed) query string. */
export async function hlsRef(input: string, url: string): Promise<VideoRef> {
  const u = new URL(url);
  const nativeId = (await sha256Hex(`${u.origin}${u.pathname}`)).slice(0, 16);
  return { input, platform: 'hls', kind: 'video', id: `hls:${nativeId}`, nativeId, url };
}

async function fetchText(url: string, ctx: Ctx): Promise<{ text: string; contentType: string }> {
  const res = await fetchWithTimeout(ctx, url, {}, 20_000);
  if (!res.ok) throw await errorFromResponse(res, `HLS playlist ${new URL(url).host}`);
  return { text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
}

/** Reduce a playlist URL (master or media) to the media playlist to follow. */
export async function resolvePlaylistUrl(
  url: string,
  ctx: Ctx,
  language?: string,
): Promise<{ mediaUrl: string; masterUrl?: string }> {
  const { text, contentType } = await fetchText(url, ctx);
  if (!isPlaylist(text)) {
    throw new Vid2ContextError(
      'unsupported-input',
      `${url.slice(0, 200)} did not return an HLS playlist (${contentType || 'unknown type'}).`,
      {
        hint: 'Pass a live YouTube URL or the .m3u8 URL of a live HLS stream.',
      },
    );
  }
  const playlist = parsePlaylist(text, url);
  if (playlist.kind === 'media') return { mediaUrl: url };
  const mediaUrl = pickAudioUri(playlist, language);
  if (!mediaUrl) {
    throw new Vid2ContextError('unsupported-input', 'The HLS master playlist lists no rendition with audio.', {
      hint: 'Pass a stream that carries audio.',
    });
  }
  return { mediaUrl, masterUrl: url };
}

/**
 * Resolve a live input. Throws `unsupported-input` (with a hint pointing at
 * the normal pipeline) for videos that are not live and inputs that have no
 * reachable HLS stream.
 */
export async function resolveLive(
  input: string,
  deps: { registry: Registry; ctx: Ctx },
  opts: { language?: string } = {},
): Promise<LiveSource> {
  const raw = input.trim();
  const { registry, ctx } = deps;

  if (isHttpUrl(raw) && looksLikeHls(raw)) {
    const { mediaUrl, masterUrl } = await resolvePlaylistUrl(raw, ctx, opts.language);
    return { ref: await hlsRef(raw, raw), mediaUrl, ...(masterUrl ? { masterUrl } : {}) };
  }

  const youtube = matchYouTubeVideo(raw);
  if (youtube) {
    const live = await youtubeLiveHls(youtube.nativeId, ctx);
    const { mediaUrl, masterUrl } = await resolvePlaylistUrl(live.hlsUrl, ctx, opts.language);
    return {
      ref: youtube,
      mediaUrl,
      ...(masterUrl ? { masterUrl } : {}),
      ...(live.title ? { title: live.title } : {}),
      ...(live.channel ? { channel: live.channel } : {}),
      ...(live.expiresAtMs ? { expiresAtMs: live.expiresAtMs } : {}),
    };
  }

  let resolved: ReturnType<Registry['resolve']> | null = null;
  try {
    resolved = registry.resolve(raw);
  } catch {
    resolved = null;
  }
  if (resolved?.ref.platform === 'youtube' && resolved.ref.kind !== 'video') {
    throw new Vid2ContextError('unsupported-input', `"${raw}" is a YouTube ${resolved.ref.kind}, not a live video.`, {
      hint: "Pass the live video itself: open the channel's /live page in a browser and copy the watch URL.",
    });
  }

  if (resolved) {
    // Another source understands the input. Ask it whether the video is live; only HLS can be followed.
    const meta = await resolved.source.getMetadata(resolved.ref, ctx).catch(() => null);
    if (meta && !meta.isLive) {
      throw new Vid2ContextError('unsupported-input', `${resolved.ref.id} is not a live stream in progress.`, {
        hint: NOT_LIVE_HINT,
      });
    }
  }

  if (isHttpUrl(raw)) {
    // A URL without a .m3u8 path can still serve a playlist (some origins use query-string routing).
    const res = await fetchWithTimeout(ctx, raw, {}, 20_000).catch(() => null);
    const type = res?.headers.get('content-type') ?? '';
    if (res?.ok && /mpegurl/i.test(type)) {
      await res.body?.cancel();
      const { mediaUrl, masterUrl } = await resolvePlaylistUrl(raw, ctx, opts.language);
      return { ref: await hlsRef(raw, raw), mediaUrl, ...(masterUrl ? { masterUrl } : {}) };
    }
    await res?.body?.cancel();
  }

  throw new Vid2ContextError('unsupported-input', `Cannot follow "${raw.slice(0, 200)}" as a live stream.`, {
    hint:
      'Live transcription follows live YouTube videos and HLS (.m3u8) stream URLs. ' +
      'For a recording, use the normal pipeline: get_transcript (MCP), GET /api/v1/transcript (HTTP) or `vid2context <url>` (CLI).',
  });
}
