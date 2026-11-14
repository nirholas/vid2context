/**
 * The live HLS manifest of a YouTube video. The innertube player response of
 * the ANDROID client carries `streamingData.hlsManifestUrl` while a video is
 * live (verified 2026-11-14 on NASA's ISS streams). The manifest is a master
 * playlist whose variants all mux audio and video; the URL is bound to the
 * requesting IP address and expires after about six hours.
 *
 * Same request as providers/youtube/src/innertube.ts, which does not export
 * its player call; the integration pass can point both at one function.
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError, type VideoRef } from '@vid2context/core';

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const DEFAULT_ANDROID_VERSION = '20.10.38';

export const BLOCKED_HINT =
  'YouTube is refusing requests from this IP address, which is common on cloud servers. ' +
  'Run vid2context on your own machine, or route it through a Cloudflare Tunnel to your home network.';

export const NOT_LIVE_HINT =
  'This video is not live right now. For a recording or a finished stream, use the normal pipeline: ' +
  'get_transcript (MCP), GET /api/v1/transcript (HTTP) or `vid2context <url>` (CLI).';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/**
 * Recognise a single YouTube video without any network call: a bare
 * 11-character id, watch?v=, youtu.be/, /live/, /embed/ and /shorts/ URLs.
 * Returns a ref shaped like the YouTube provider's, so ids match the library.
 */
export function matchYouTubeVideo(raw: string): VideoRef | null {
  const input = raw.trim();
  const ref = (id: string): VideoRef => ({
    input,
    platform: 'youtube',
    kind: 'video',
    id: `youtube:${id}`,
    nativeId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
  });
  if (VIDEO_ID.test(input)) return ref(input);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') return parts[0] && VIDEO_ID.test(parts[0]) ? ref(parts[0]) : null;
  const v = url.searchParams.get('v');
  if (v && VIDEO_ID.test(v)) return ref(v);
  const [first, second] = parts;
  if (first && second && ['live', 'embed', 'shorts', 'v'].includes(first) && VIDEO_ID.test(second)) return ref(second);
  return null;
}

interface LivePlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    channelId?: string;
    isLive?: boolean;
    isLiveContent?: boolean;
    isUpcoming?: boolean;
  };
  streamingData?: { expiresInSeconds?: string; hlsManifestUrl?: string };
}

export interface YouTubeLive {
  hlsUrl: string;
  title?: string;
  channel?: string;
  /** Epoch ms after which the manifest URL stops working. */
  expiresAtMs?: number;
}

function playabilityError(p: LivePlayerResponse, videoId: string): Vid2ContextError | null {
  const status = p.playabilityStatus?.status ?? 'OK';
  const reason = p.playabilityStatus?.reason ?? '';
  if (status === 'OK') return null;
  const msg = `YouTube ${videoId}: ${status}${reason ? ` (${reason})` : ''}`;
  if (status === 'LOGIN_REQUIRED' && /bot/i.test(reason)) return new Vid2ContextError('blocked', msg, { hint: BLOCKED_HINT });
  if (status === 'ERROR') {
    return new Vid2ContextError('not-found', msg, { hint: 'Check the video id or URL; the video may have been removed.' });
  }
  if (status === 'LIVE_STREAM_OFFLINE') {
    return new Vid2ContextError('unavailable', msg, {
      hint: 'This live stream has not started yet (or is between sessions). Start watching once it is live.',
    });
  }
  return new Vid2ContextError('unavailable', msg, { hint: 'The video is private, members-only or otherwise not playable.' });
}

/** Ask the ANDROID player for a live video's HLS manifest. Throws `unsupported-input` when the video is not live. */
export async function youtubeLiveHls(videoId: string, ctx: Ctx): Promise<YouTubeLive> {
  const version = ctx.env.YOUTUBE_ANDROID_VERSION || DEFAULT_ANDROID_VERSION;
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
  if (res.status === 429) {
    throw new Vid2ContextError('blocked', `YouTube player ${videoId}: HTTP 429`, { status: 429, hint: BLOCKED_HINT });
  }
  if (!res.ok) throw await errorFromResponse(res, `YouTube player ${videoId}`);
  const player = (await res.json()) as LivePlayerResponse;
  const err = playabilityError(player, videoId);
  if (err) throw err;
  const details = player.videoDetails;
  const hlsUrl = player.streamingData?.hlsManifestUrl;
  if (!details?.isLive || !hlsUrl) {
    throw new Vid2ContextError(
      'unsupported-input',
      `YouTube ${videoId}${details?.title ? ` ("${details.title}")` : ''} is not a live stream in progress.`,
      { hint: NOT_LIVE_HINT },
    );
  }
  const expires = Number(player.streamingData?.expiresInSeconds);
  return {
    hlsUrl,
    ...(details.title ? { title: details.title } : {}),
    ...(details.author ? { channel: details.author } : {}),
    ...(Number.isFinite(expires) && expires > 0 ? { expiresAtMs: Date.now() + expires * 1000 } : {}),
  };
}
