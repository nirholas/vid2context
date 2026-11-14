import {
  type CaptionOptions,
  type CaptionTrackInfo,
  type Ctx,
  fetchWithTimeout,
  type Segment,
  Vid2ContextError,
} from '@vid2context/core';
import { type PlayerResponse, type RawCaptionTrack, youtubeHttpError } from './innertube.ts';
import { parseSrv1, parseTimedText } from './timedtext.ts';

export const isAsr = (t: RawCaptionTrack): boolean => t.kind === 'asr';

export function tracksOf(player: PlayerResponse): RawCaptionTrack[] {
  return player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

function defaultTrackIndex(player: PlayerResponse): number | undefined {
  return player.captions?.playerCaptionsTracklistRenderer?.audioTracks?.[0]?.defaultCaptionTrackIndex;
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

/** Exact language match first, then same primary subtag (en matches en-GB and the reverse). */
function byLanguage(tracks: RawCaptionTrack[], language: string): RawCaptionTrack | undefined {
  const want = language.toLowerCase();
  return tracks.find((t) => t.languageCode.toLowerCase() === want) ?? tracks.find((t) => primary(t.languageCode) === primary(want));
}

export interface TrackChoice {
  track: RawCaptionTrack;
  origin: 'creator-captions' | 'auto-captions';
  /** Set when the track must be machine-translated by YouTube (tlang) into this language. */
  translateTo?: string;
}

const choice = (track: RawCaptionTrack, translateTo?: string): TrackChoice => ({
  track,
  origin: isAsr(track) ? 'auto-captions' : 'creator-captions',
  ...(translateTo ? { translateTo } : {}),
});

/**
 * Pick the best track.
 * With a language: a creator track in it, then an auto track in it, then
 * (when allowed) YouTube's translation of the best untranslated track.
 * Without: a creator track in the spoken language, then the video's default
 * creator track, then any creator track, then the auto track.
 */
export function chooseTrack(tracks: RawCaptionTrack[], opts: CaptionOptions, defaultIndex?: number): TrackChoice | null {
  const allowAuto = opts.allowAuto ?? true;
  const creator = tracks.filter((t) => !isAsr(t));
  const auto = allowAuto ? tracks.filter(isAsr) : [];

  const best = (): RawCaptionTrack | undefined => {
    const spoken = spokenLanguage(tracks);
    const def = defaultIndex === undefined ? undefined : tracks[defaultIndex];
    return (
      (spoken ? byLanguage(creator, spoken) : undefined) ?? (def && !isAsr(def) ? def : undefined) ?? creator[0] ?? auto[0]
    );
  };

  if (opts.language) {
    const direct = byLanguage(creator, opts.language) ?? byLanguage(auto, opts.language);
    if (direct) return choice(direct);
    if (opts.allowTranslated ?? true) {
      const source = best();
      if (source && source.isTranslatable !== false) return choice(source, opts.language);
    }
    return null;
  }
  const picked = best();
  return picked ? choice(picked) : null;
}

export function choose(player: PlayerResponse, opts: CaptionOptions): TrackChoice | null {
  return chooseTrack(tracksOf(player), opts, defaultTrackIndex(player));
}

/** Download a track as srv3 (srv1 as a fallback) and parse it into segments. */
export async function fetchTrack(track: RawCaptionTrack, ctx: Ctx, translateTo?: string): Promise<Segment[]> {
  const url = new URL(track.baseUrl);
  url.searchParams.set('fmt', 'srv3');
  if (translateTo) url.searchParams.set('tlang', translateTo);
  const label = `YouTube captions ${track.languageCode}${translateTo ? `->${translateTo}` : ''}`;

  const res = await fetchWithTimeout(ctx, url.href);
  if (!res.ok) throw await youtubeHttpError(res, label);
  const body = await res.text();
  const segments = parseTimedText(body);
  if (segments.length > 0) return segments;

  url.searchParams.delete('fmt');
  const res1 = await fetchWithTimeout(ctx, url.href);
  if (!res1.ok) throw await youtubeHttpError(res1, label);
  const srv1 = parseSrv1(await res1.text());
  if (srv1.length > 0) return srv1;

  throw new Vid2ContextError('upstream', `${label}: the caption payload was empty.`, {
    hint: 'YouTube returned an empty track. This happens when it requires a proof-of-origin token for this client; retry later or use mode "stt".',
  });
}
