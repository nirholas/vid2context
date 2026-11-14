/**
 * The bridge's transcript and metadata shapes (docs/contracts/transcript-import.md),
 * built from a player response, whether the background got it from innertube
 * or the YouTube tab read it from the page. Both have the same fields.
 */
import { type Segment, Vid2ContextError } from '@vid2context/core';
import { chooseTrack } from '@vid2context/provider-youtube';
import type { BridgeMetadata, BridgeTranscript, ResultBody, TranscriptRequest } from '../lib/bridge-protocol.ts';
import { type CaptionDeps, fetchCaptionSegments, type PoToken } from './captions.ts';
import type { CaptionTrack } from './player.ts';

export type TrackChoice = NonNullable<ReturnType<typeof chooseTrack>>;

/** The parts of a player response (innertube or watch page) the bridge reads. */
export interface PlayerLike {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; author?: string; lengthSeconds?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      audioTracks?: { defaultCaptionTrackIndex?: number }[];
      translationLanguages?: { languageCode: string }[];
    };
  };
}

export function tracksOf(player: PlayerLike): CaptionTrack[] {
  return player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

/** The provider's track rules (chooseTrack), with YouTube's own list of translation targets. */
export function chooseFor(player: PlayerLike, language?: string): TrackChoice | null {
  const list = player.captions?.playerCaptionsTracklistRenderer;
  return chooseTrack(
    tracksOf(player),
    language ? { language } : {},
    list?.audioTracks?.[0]?.defaultCaptionTrackIndex,
    (list?.translationLanguages ?? []).map((l) => l.languageCode),
  );
}

export function trackName(track: CaptionTrack): string | undefined {
  const name = track.name?.simpleText ?? track.name?.runs?.map((r) => r.text).join('');
  return name || undefined;
}

export function bridgeTranscript(choice: TrackChoice, segments: Segment[]): BridgeTranscript {
  const name = trackName(choice.track);
  return {
    language: choice.translateTo ?? choice.track.languageCode,
    kind: choice.origin,
    ...(name ? { name } : {}),
    ...(choice.translateTo ? { translated: true } : {}),
    segments: segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text })),
  };
}

export function bridgeMetadata(player: PlayerLike): BridgeMetadata | undefined {
  const d = player.videoDetails;
  if (!d) return undefined;
  const durationSec = Number(d.lengthSeconds);
  const meta: BridgeMetadata = {};
  if (d.title) meta.title = d.title;
  if (d.author) meta.channel = d.author;
  if (Number.isFinite(durationSec) && durationSec > 0) meta.durationSec = durationSec;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** The languages a video offers, for a "no track in that language" hint. */
export function trackLanguages(player: PlayerLike): string[] {
  return [...new Set(tracksOf(player).map((t) => t.languageCode))];
}

/** The error for a player response that has no track for the request. */
export function noTrackError(player: PlayerLike, videoId: string, language?: string): Vid2ContextError {
  const status = player.playabilityStatus?.status;
  const languages = trackLanguages(player);
  if (languages.length === 0 && status && status !== 'OK') {
    const reason = player.playabilityStatus?.reason;
    return new Vid2ContextError(
      'unavailable',
      `YouTube says ${videoId} is not playable (${status}${reason ? `: ${reason}` : ''}).`,
    );
  }
  if (languages.length > 0 && language) {
    return new Vid2ContextError(
      'no-transcript',
      `YouTube has no ${language} captions for ${videoId}, and cannot translate into ${language}. It has: ${languages.join(', ')}.`,
    );
  }
  return new Vid2ContextError('no-transcript', `YouTube has no captions for ${videoId}.`);
}

/**
 * In the YouTube tab: the requested track from the page's player response,
 * downloaded from youtube.com with the page's cookies and, when the plain URL
 * comes back empty, the player's proof-of-origin token.
 */
export async function transcriptFromPage(
  player: PlayerLike,
  request: TranscriptRequest,
  deps: Pick<CaptionDeps, 'fetch' | 'signal'> & {
    /** The player's token, borrowed by switching the player to captions in `languageCode`. */
    getPoToken: (languageCode: string) => Promise<PoToken | null>;
  },
): Promise<Extract<ResultBody, { ok: true }>> {
  const choice = chooseFor(player, request.language);
  if (!choice) throw noTrackError(player, request.videoId, request.language);
  const { segments } = await fetchCaptionSegments(choice.track, {
    fetch: deps.fetch,
    ...(deps.signal ? { signal: deps.signal } : {}),
    getPoToken: () => deps.getPoToken(choice.track.languageCode),
    ...(choice.translateTo ? { translateTo: choice.translateTo } : {}),
  });
  const metadata = bridgeMetadata(player);
  return { ok: true, transcript: bridgeTranscript(choice, segments), ...(metadata ? { metadata } : {}) };
}
