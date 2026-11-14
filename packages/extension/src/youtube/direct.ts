/**
 * Step 1 of the bridge: the YouTube provider's own innertube player call and
 * timedtext download, sent from the extension's background with the user's IP
 * address. The outcome says whether the answer is final or whether the
 * YouTube tab (step 2) should try.
 *
 * Final: a transcript, a removed or nonexistent video, a live stream or
 * premiere that has not ended, a playable video without captions, or no track
 * for the requested language. Everything else goes to the tab: a refused or
 * blocked request, an empty track (YouTube wants a proof-of-origin token), and
 * login, age and members-only walls, which the user's own YouTube session in
 * the tab may get past.
 */
import type { Ctx } from '@vid2context/core';
import { fetchPlayer, fetchTrack, type PlayerResponse, playabilityError } from '@vid2context/provider-youtube';
import { BRIDGE_HINTS, bridgeError, toBridgeError } from '../lib/bridge-errors.ts';
import type { BridgeError, ProgressStage, ResultBody, TranscriptRequest } from '../lib/bridge-protocol.ts';
import { bridgeMetadata, bridgeTranscript, chooseFor, noTrackError, tracksOf } from './transcript.ts';

export type DirectOutcome =
  | { kind: 'ok'; body: Extract<ResultBody, { ok: true }> }
  | { kind: 'final'; error: BridgeError }
  /** Let the YouTube tab try. `reason` is what went wrong here, kept for the final message. */
  | { kind: 'fallback'; reason: BridgeError };

export type Progress = (stage: ProgressStage, message: string) => void;

function finalFor(player: PlayerResponse, videoId: string): BridgeError | null {
  const status = player.playabilityStatus?.status ?? 'OK';
  const verdict = playabilityError(player, videoId);
  if (status === 'ERROR') return bridgeError('not-found', verdict?.message ?? `YouTube says ${videoId} does not exist.`);
  if (status === 'LIVE_STREAM_OFFLINE') {
    return bridgeError(
      'unavailable',
      verdict?.message ?? `YouTube ${videoId}: the live stream has not started.`,
      'YouTube publishes captions for a live stream or premiere after it ends. Try again then.',
    );
  }
  if (status === 'OK' && player.videoDetails?.isLive) {
    return bridgeError(
      'unavailable',
      `YouTube ${videoId}: the live stream has not ended.`,
      'YouTube publishes captions for a live stream after it ends. Try again then.',
    );
  }
  if (status === 'OK') return bridgeError('no-captions', `YouTube has no captions for ${videoId}.`);
  return null;
}

export async function fetchDirect(request: TranscriptRequest, ctx: Ctx, progress: Progress): Promise<DirectOutcome> {
  const { videoId, language } = request;
  progress('player', 'Asking YouTube for the caption tracks from your browser.');
  let player: PlayerResponse;
  try {
    player = await fetchPlayer(videoId, ctx);
  } catch (err) {
    return { kind: 'fallback', reason: toBridgeError(err) };
  }

  if (tracksOf(player).length === 0) {
    const final = finalFor(player, videoId);
    if (final) return { kind: 'final', error: final };
    const verdict = playabilityError(player, videoId);
    return {
      kind: 'fallback',
      reason: verdict ? toBridgeError(verdict) : bridgeError('unavailable', `YouTube sent no captions for ${videoId}.`),
    };
  }

  const choice = chooseFor(player, language);
  if (!choice) {
    const err = noTrackError(player, videoId, language);
    return { kind: 'final', error: bridgeError('no-captions', err.message, BRIDGE_HINTS['no-captions']) };
  }

  const what = choice.translateTo
    ? `${choice.track.languageCode} captions, translated to ${choice.translateTo}`
    : `${choice.track.languageCode} captions`;
  progress('captions', `Downloading the ${what}.`);
  try {
    const segments = await fetchTrack(choice.track, ctx, choice.translateTo, player.client);
    const metadata = bridgeMetadata(player);
    return { kind: 'ok', body: { ok: true, transcript: bridgeTranscript(choice, segments), ...(metadata ? { metadata } : {}) } };
  } catch (err) {
    return { kind: 'fallback', reason: toBridgeError(err) };
  }
}
