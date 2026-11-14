/**
 * Minimal innertube client. The ANDROID client returns caption tracks with
 * directly fetchable baseUrls (no PO token) and needs no API key. YouTube
 * raises the minimum accepted client version from time to time; override it
 * with YOUTUBE_ANDROID_VERSION without a release.
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const DEFAULT_ANDROID_VERSION = '20.10.38';

export const BLOCKED_HINT =
  'YouTube is refusing requests from this IP address, which is common on cloud servers. ' +
  'Run vid2context on your own machine, route the server through a Cloudflare Tunnel to your home network, ' +
  'or retry later.';

export interface RawCaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
  vssId?: string;
  isTranslatable?: boolean;
}

export interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: {
    videoId: string;
    title?: string;
    lengthSeconds?: string;
    keywords?: string[];
    channelId?: string;
    shortDescription?: string;
    thumbnail?: { thumbnails?: { url: string; width?: number; height?: number }[] };
    viewCount?: string;
    author?: string;
    isLiveContent?: boolean;
    isLive?: boolean;
    isPrivate?: boolean;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: RawCaptionTrack[];
      audioTracks?: { captionTrackIndices?: number[]; defaultCaptionTrackIndex?: number }[];
      translationLanguages?: { languageCode: string; languageName?: { simpleText?: string; runs?: { text: string }[] } }[];
    };
  };
}

function androidVersion(ctx: Ctx): string {
  return ctx.env.YOUTUBE_ANDROID_VERSION || DEFAULT_ANDROID_VERSION;
}

/** Map a YouTube rate-limit page or HTTP error to a Vid2ContextError. */
export async function youtubeHttpError(res: Response, label: string): Promise<Vid2ContextError> {
  if (res.status === 429) {
    const body = await res.text().catch(() => '');
    if (/automated queries|unusual traffic|sorry/i.test(body)) {
      return new Vid2ContextError('blocked', `${label}: YouTube answered HTTP 429 (automated-traffic block).`, {
        status: 429,
        hint: BLOCKED_HINT,
      });
    }
    return new Vid2ContextError('rate-limited', `${label}: HTTP 429`, { status: 429, hint: BLOCKED_HINT });
  }
  return errorFromResponse(res, label);
}

/** Turn a non-OK playabilityStatus into an error. Returns null when the video is playable. */
export function playabilityError(player: PlayerResponse, videoId: string): Vid2ContextError | null {
  const status = player.playabilityStatus?.status ?? 'OK';
  const reason = player.playabilityStatus?.reason ?? '';
  if (status === 'OK') return null;
  const msg = `YouTube ${videoId}: ${status}${reason ? ` (${reason})` : ''}`;
  if (status === 'LOGIN_REQUIRED' && /bot/i.test(reason)) return new Vid2ContextError('blocked', msg, { hint: BLOCKED_HINT });
  if (status === 'LOGIN_REQUIRED' && /age|inappropriate/i.test(reason)) {
    return new Vid2ContextError('unavailable', msg, { hint: 'This video is age-restricted and needs a signed-in session.' });
  }
  if (status === 'ERROR')
    return new Vid2ContextError('not-found', msg, { hint: 'Check the video id or URL; the video may have been removed.' });
  if (status === 'LIVE_STREAM_OFFLINE') {
    return new Vid2ContextError('unavailable', msg, { hint: 'This live stream or premiere has not started yet.' });
  }
  return new Vid2ContextError('unavailable', msg, { hint: 'The video is private, members-only or otherwise not playable.' });
}

/** POST /youtubei/v1/player with the ANDROID client. */
export async function fetchPlayer(videoId: string, ctx: Ctx): Promise<PlayerResponse> {
  const version = androidVersion(ctx);
  const res = await fetchWithTimeout(ctx, PLAYER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': `com.google.android.youtube/${version} (Linux; U; Android 11) gzip`,
      'x-youtube-client-name': '3',
      'x-youtube-client-version': version,
    },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: version, androidSdkVersion: 30, hl: 'en' } },
      videoId,
    }),
  });
  if (!res.ok) throw await youtubeHttpError(res, `YouTube player ${videoId}`);
  return (await res.json()) as PlayerResponse;
}

/**
 * One player response per video per Ctx. The pipeline calls getMetadata and
 * then getCaptions with the same ctx, so the second call is free; a new ctx
 * (a new request or CLI run) always sees fresh data.
 */
const perCtx = new WeakMap<Ctx, Map<string, Promise<PlayerResponse>>>();

export function getPlayer(videoId: string, ctx: Ctx): Promise<PlayerResponse> {
  let cache = perCtx.get(ctx);
  if (!cache) {
    cache = new Map();
    perCtx.set(ctx, cache);
  }
  let pending = cache.get(videoId);
  if (!pending) {
    pending = fetchPlayer(videoId, ctx);
    cache.set(videoId, pending);
    pending.catch(() => cache.delete(videoId));
  }
  return pending;
}
