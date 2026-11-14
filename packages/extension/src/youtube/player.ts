/**
 * The player response YouTube embeds in every watch page
 * (`var ytInitialPlayerResponse = {...};`), and the subset of it this
 * extension reads. The same object is what `movie_player.getPlayerResponse()`
 * returns after single-page navigation.
 */
import { Vid2ContextError } from '@vid2context/core';
import type { chooseTrack } from '@vid2context/provider-youtube';

/** A caption track as the player response lists it; the shape the provider's `chooseTrack` takes. */
export type CaptionTrack = Parameters<typeof chooseTrack>[0][number];

export interface WatchPlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: {
    videoId?: string;
    title?: string;
    lengthSeconds?: string;
    channelId?: string;
    author?: string;
    shortDescription?: string;
    keywords?: string[];
    isLive?: boolean;
    isLiveContent?: boolean;
    viewCount?: string;
    thumbnail?: { thumbnails?: { url: string; width?: number; height?: number }[] };
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      audioTracks?: { defaultCaptionTrackIndex?: number }[];
    };
  };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string; uploadDate?: string; category?: string } };
}

/** The JSON object literal that starts at `start` (which must be `{`), or null when it never closes. */
export function objectAt(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Find `ytInitialPlayerResponse = {...}` in watch page HTML and parse it.
 * With `videoId`, only a response for that video counts (after single-page
 * navigation the HTML can still hold the first video's response).
 */
export function extractPlayerResponse(html: string, videoId?: string): WatchPlayerResponse | null {
  const re = /ytInitialPlayerResponse\s*=\s*\{/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const json = objectAt(html, m.index + m[0].length - 1);
    if (!json) continue;
    let parsed: WatchPlayerResponse;
    try {
      parsed = JSON.parse(json) as WatchPlayerResponse;
    } catch {
      continue;
    }
    if (!videoId || parsed.videoDetails?.videoId === videoId) return parsed;
  }
  return null;
}

export function captionTracks(player: WatchPlayerResponse): CaptionTrack[] {
  return player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

export function defaultTrackIndex(player: WatchPlayerResponse): number | undefined {
  return player.captions?.playerCaptionsTracklistRenderer?.audioTracks?.[0]?.defaultCaptionTrackIndex;
}

/**
 * A player response that refuses to play and carries no videoDetails, such as
 * YouTube's "Sign in to confirm you're not a bot" wall, or null. Such a
 * response has no video id, so extractPlayerResponse(html, videoId) skips it.
 */
export function playabilityWall(source: string): WatchPlayerResponse | null {
  const p = extractPlayerResponse(source);
  const status = p?.playabilityStatus?.status;
  return p && !p.videoDetails && status && status !== 'OK' ? p : null;
}

/** The error to show for a playability wall. */
export function wallError(wall: WatchPlayerResponse, videoId: string): Vid2ContextError {
  const status = wall.playabilityStatus?.status ?? 'UNPLAYABLE';
  const reason = (wall.playabilityStatus?.reason ?? '').replace(/\u2019/g, "'");
  if (/not a bot/i.test(reason)) {
    return new Vid2ContextError('blocked', `YouTube asks this browser to sign in to confirm it is not a bot (${videoId}).`, {
      hint: 'Sign in to YouTube in this browser, or wait a while and try again.',
    });
  }
  return new Vid2ContextError('unavailable', `YouTube will not play ${videoId} here (${status}${reason ? `: ${reason}` : ''}).`, {
    hint: 'Open the video on YouTube to see why, sign in if it asks, then try again.',
  });
}
