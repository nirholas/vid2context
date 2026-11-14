/**
 * The player response YouTube embeds in every watch page
 * (`var ytInitialPlayerResponse = {...};`), and the subset of it this
 * extension reads. The same object is what `movie_player.getPlayerResponse()`
 * returns after single-page navigation.
 */
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
