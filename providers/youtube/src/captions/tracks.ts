/**
 * Caption track choice.
 *
 * With a requested language:
 *   1. a creator track in that language
 *   2. an auto (asr) track in that language (unless allowAuto is false)
 *   3. YouTube's machine translation (tlang) of the best translatable track
 *      (unless allowTranslated is false)
 * Without:
 *   1. a creator track in the spoken language (the asr track's language reveals it)
 *   2. any creator track, the video's default track first
 *   3. the asr track (unless allowAuto is false)
 *
 * Languages match exactly first, then by primary subtag (en matches en-GB).
 */
import type { CaptionOptions, CaptionTrackInfo } from '@vid2context/core';
import type { PlayerResponse, RawCaptionTrack } from '../resilience/player.ts';

export const isAsr = (t: RawCaptionTrack): boolean => t.kind === 'asr';

export function tracksOf(player: PlayerResponse): RawCaptionTrack[] {
  return player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

export function defaultTrackIndex(player: PlayerResponse): number | undefined {
  return player.captions?.playerCaptionsTracklistRenderer?.audioTracks?.[0]?.defaultCaptionTrackIndex;
}

/** Language codes YouTube offers as translation targets for this video. */
export function translationTargets(player: PlayerResponse): string[] {
  return (player.captions?.playerCaptionsTracklistRenderer?.translationLanguages ?? []).map((l) => l.languageCode);
}

export function trackName(t: RawCaptionTrack): string {
  return t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? t.languageCode;
}

export function trackInfo(t: RawCaptionTrack): CaptionTrackInfo {
  return {
    language: t.languageCode,
    name: trackName(t),
    origin: isAsr(t) ? 'auto-captions' : 'creator-captions',
    translatable: t.isTranslatable,
  };
}

/** The spoken language, revealed by the auto-caption track's language when there is one. */
export function spokenLanguage(tracks: RawCaptionTrack[]): string | undefined {
  return tracks.find(isAsr)?.languageCode;
}

const primary = (code: string): string => code.toLowerCase().split(/[-_]/)[0] ?? '';

/** Exact match first, then same primary subtag. */
function matchCode<T>(items: T[], language: string, code: (item: T) => string): T | undefined {
  const want = language.toLowerCase();
  return items.find((i) => code(i).toLowerCase() === want) ?? items.find((i) => primary(code(i)) === primary(want));
}

const byLanguage = (tracks: RawCaptionTrack[], language: string) => matchCode(tracks, language, (t) => t.languageCode);

export interface TrackChoice {
  track: RawCaptionTrack;
  origin: 'creator-captions' | 'auto-captions';
  /** Set when YouTube must machine-translate the track (tlang) into this language. */
  translateTo?: string;
}

const choice = (track: RawCaptionTrack, translateTo?: string): TrackChoice => ({
  track,
  origin: isAsr(track) ? 'auto-captions' : 'creator-captions',
  ...(translateTo ? { translateTo } : {}),
});

/**
 * Pick the best track (rules at the top of this file). `translationLanguages`
 * is the player's list of translation targets: when given, a translation is
 * offered only into a listed language, using YouTube's own code for it.
 */
export function chooseTrack(
  tracks: RawCaptionTrack[],
  opts: CaptionOptions,
  defaultIndex?: number,
  translationLanguages?: string[],
): TrackChoice | null {
  const allowAuto = opts.allowAuto ?? true;
  const creator = tracks.filter((t) => !isAsr(t));
  const auto = allowAuto ? tracks.filter(isAsr) : [];
  const def = defaultIndex === undefined ? undefined : tracks[defaultIndex];
  const defCreator = def && !isAsr(def) ? def : undefined;
  const spoken = spokenLanguage(tracks);

  // Best tracks without a language preference, in order.
  const ranked = [spoken ? byLanguage(creator, spoken) : undefined, defCreator, ...creator, ...auto].filter(
    (t, i, all): t is RawCaptionTrack => t !== undefined && all.indexOf(t) === i,
  );

  if (!opts.language) return ranked[0] ? choice(ranked[0]) : null;

  const direct = byLanguage(creator, opts.language) ?? byLanguage(auto, opts.language);
  if (direct) return choice(direct);
  if (opts.allowTranslated === false) return null;
  let target = opts.language;
  if (translationLanguages && translationLanguages.length > 0) {
    const listed = matchCode(translationLanguages, opts.language, (c) => c);
    if (!listed) return null;
    target = listed;
  }
  const source = ranked.find((t) => t.isTranslatable !== false);
  return source ? choice(source, target) : null;
}

export function choose(player: PlayerResponse, opts: CaptionOptions): TrackChoice | null {
  return chooseTrack(tracksOf(player), opts, defaultTrackIndex(player), translationTargets(player));
}
