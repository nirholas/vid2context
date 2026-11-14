/**
 * Everything "Copy for AI" and "Download .zip" need, computed in the page:
 * player response, track choice, caption download, VideoContext.
 */
import { Vid2ContextError, type VideoContext } from '@vid2context/core';
import type { ResultBody, TranscriptRequest } from '../lib/bridge-protocol.ts';
import { fetchCaptionSegments, poTokenFromUrl } from '../youtube/captions.ts';
import { buildVideoContext, pickTrack } from '../youtube/context.ts';
import { captionTracks, extractPlayerResponse, playabilityWall, type WatchPlayerResponse, wallError } from '../youtube/player.ts';
import { transcriptFromPage } from '../youtube/transcript.ts';
import { askPage } from './bridge.ts';

const PAGE_TIMEOUT_MS = 1500;
const TOKEN_TIMEOUT_MS = 8000;

export const NO_CAPTIONS_HINT = 'Use "Open in vid2context", which can transcribe the audio instead.';

/** The player response for this video: the live player, then the page's scripts, then a fresh fetch of the watch page. */
export async function playerFor(videoId: string): Promise<WatchPlayerResponse> {
  const live = (await askPage({ op: 'player', videoId }, PAGE_TIMEOUT_MS)) as WatchPlayerResponse | null;
  if (live?.videoDetails) return live;
  // A wall (the bot check, a sign-in request) has no video id; remember it to say why nothing was found.
  let wall: WatchPlayerResponse | null = null;
  for (const script of Array.from(document.scripts)) {
    const text = script.textContent ?? '';
    if (!text.includes('ytInitialPlayerResponse')) continue;
    const found = extractPlayerResponse(text, videoId);
    if (found) return found;
    wall ??= playabilityWall(text);
  }
  const res = await fetch(`https://${location.host}/watch?v=${encodeURIComponent(videoId)}`, { credentials: 'include' });
  const html = res.ok ? await res.text() : '';
  const fetched = html ? extractPlayerResponse(html, videoId) : null;
  if (fetched) return fetched;
  wall ??= html ? playabilityWall(html) : null;
  if (wall) throw wallError(wall, videoId);
  throw new Vid2ContextError('upstream', 'Could not read this video from the page.', {
    hint: 'Reload the page and try again.',
  });
}

export function hasCaptions(player: WatchPlayerResponse): boolean {
  return captionTracks(player).length > 0;
}

function tokenGetter(videoId: string, languageCode: string) {
  return async () => {
    const url = await askPage({ op: 'pot', videoId, languageCode }, TOKEN_TIMEOUT_MS);
    return typeof url === 'string' ? poTokenFromUrl(url, videoId) : null;
  };
}

/** For the web app bridge's YouTube tab: the requested track, in the bridge's transcript shape. */
export async function bridgeTranscriptFor(request: TranscriptRequest): Promise<Extract<ResultBody, { ok: true }>> {
  const player = await playerFor(request.videoId);
  return transcriptFromPage(player, request, {
    fetch: (input, init) => fetch(input, init),
    getPoToken: (languageCode) => tokenGetter(request.videoId, languageCode)(),
  });
}

export async function contextFor(videoId: string): Promise<VideoContext> {
  const player = await playerFor(videoId);
  const status = player.playabilityStatus?.status;
  const choice = pickTrack(player);
  if (!choice) {
    if (status && status !== 'OK') {
      throw new Vid2ContextError('unavailable', `YouTube says this video is not playable (${status}).`, {
        hint: player.playabilityStatus?.reason ?? 'Sign in or check that the video is public.',
      });
    }
    throw new Vid2ContextError('no-transcript', 'This video has no captions.', { hint: NO_CAPTIONS_HINT });
  }
  const started = Date.now();
  const { segments, usedPoToken } = await fetchCaptionSegments(choice.track, {
    fetch: (input, init) => fetch(input, init),
    getPoToken: tokenGetter(videoId, choice.track.languageCode),
  });
  return buildVideoContext({ player, choice, segments, usedPoToken, ms: Date.now() - started });
}
