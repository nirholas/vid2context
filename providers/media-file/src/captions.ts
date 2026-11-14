/**
 * `media-file-captions`: subtitles that already come with a local file.
 *
 *   1. Sidecar files next to the media: talk.srt, talk.vtt, talk.en.srt,
 *      talk.pt-BR.vtt, talk.en.forced.srt (language from the file name).
 *   2. Text subtitle streams embedded in the container (mkv, mp4 mov_text),
 *      read with ffmpeg when it is installed.
 *
 * Both count as `creator-captions`: someone made them for this file. Forced
 * tracks (only the foreign-language lines) are listed but never chosen as the
 * transcript.
 */
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CaptionOptions,
  type CaptionsProvider,
  type CaptionTrackInfo,
  type Ctx,
  defineProvider,
  type Segment,
  type Transcript,
  type VideoRef,
} from '@vid2context/core';
import { extractSubtitles, type ProbeResult, textSubtitleStreams, toBcp47 } from '@vid2context/ffmpeg';
import { probeIfAvailable } from './files.ts';
import { parseSubtitles } from './subtitles.ts';

export interface SubtitleTrack {
  kind: 'sidecar' | 'embedded';
  /** BCP-47, when the file name or stream tag says. */
  language?: string;
  forced: boolean;
  isDefault: boolean;
  /** Sidecar path. */
  path?: string;
  /** Embedded stream index. */
  streamIndex?: number;
  /** File name or stream title, for listings. */
  name: string;
}

const SUB_EXT = new Set(['.srt', '.vtt']);
const MODIFIERS = new Set(['forced', 'sdh', 'cc', 'default', 'full']);
const LANG = /^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i;

/**
 * Sidecar subtitle files for a media path. A file belongs to `talk.mp4` when
 * it is `talk.srt`/`talk.vtt` or `talk.<parts>.srt` where every part is a
 * language tag or a modifier (forced, sdh, cc); `talk.final.srt` is left
 * alone because it may belong to `talk.final.mp4`.
 */
export function findSidecars(mediaPath: string): SubtitleTrack[] {
  const dir = dirname(mediaPath);
  const name = basename(mediaPath);
  const stem = name.slice(0, name.length - extname(name).length);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SubtitleTrack[] = [];
  for (const entry of entries.sort()) {
    const ext = extname(entry).toLowerCase();
    if (!SUB_EXT.has(ext) || !entry.startsWith(stem)) continue;
    const middle = entry.slice(stem.length, entry.length - ext.length);
    if (middle !== '' && !middle.startsWith('.')) continue;
    const parts = middle.split('.').filter(Boolean);
    let language: string | undefined;
    let forced = false;
    let isDefault = false;
    let ok = true;
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (MODIFIERS.has(lower)) {
        if (lower === 'forced') forced = true;
        if (lower === 'default') isDefault = true;
      } else if (!language && LANG.test(part)) {
        language = toBcp47(part);
      } else {
        ok = false;
      }
    }
    if (ok) out.push({ kind: 'sidecar', language, forced, isDefault, path: join(dir, entry), name: entry });
  }
  // Untagged first (talk.srt is the most deliberate choice), then default, then by name.
  return out.sort(
    (a, b) => Number(a.language !== undefined) - Number(b.language !== undefined) || Number(b.isDefault) - Number(a.isDefault),
  );
}

function embeddedTracks(p: ProbeResult | null): SubtitleTrack[] {
  if (!p) return [];
  return textSubtitleStreams(p.streams).map((s) => ({
    kind: 'embedded' as const,
    language: s.language,
    forced: s.isForced ?? false,
    isDefault: s.isDefault ?? false,
    streamIndex: s.index,
    name: s.title ?? `stream ${s.index} (${s.codec})`,
  }));
}

const primary = (lang: string) => lang.toLowerCase().split('-')[0];

/**
 * Order the usable (non-forced) tracks for a requested language: exact or
 * same-primary-language tracks first, then untagged ones. With a requested
 * language and only other-language tracks, nothing is returned so speech-to-text
 * can run instead. Without one, every track qualifies, those in the spoken
 * language first.
 */
export function rankTracks(tracks: SubtitleTrack[], language: string | undefined, spoken: string | undefined): SubtitleTrack[] {
  const usable = tracks.filter((t) => !t.forced);
  const want = language ?? spoken;
  const matching = want ? usable.filter((t) => t.language && primary(t.language) === primary(want)) : [];
  const untagged = usable.filter((t) => !t.language);
  const rest = language ? [] : usable.filter((t) => !matching.includes(t) && !untagged.includes(t));
  return [...matching, ...untagged, ...rest];
}

async function readTrack(track: SubtitleTrack, mediaPath: string, ctx: Ctx): Promise<Segment[]> {
  if (track.kind === 'sidecar' && track.path) return parseSubtitles(await readFile(track.path, 'utf8'));
  return parseSubtitles(await extractSubtitles(mediaPath, track.streamIndex, ctx));
}

function mediaPathOf(ref: VideoRef): string | null {
  if (ref.platform !== 'file' || !ref.url) return null;
  try {
    return fileURLToPath(ref.url);
  } catch {
    return null;
  }
}

export const mediaFileCaptions: CaptionsProvider = defineProvider({
  id: 'media-file-captions',
  kind: 'captions',
  name: 'Subtitles of a local file (sidecar and embedded)',
  runtimes: ['node'],
  supports: (ref) => ref.platform === 'file',
  async listTracks(ref, ctx): Promise<CaptionTrackInfo[]> {
    const path = mediaPathOf(ref);
    if (!path) return [];
    const tracks = [...findSidecars(path), ...embeddedTracks(await probeIfAvailable(path, ctx))];
    return tracks.map((t) => ({
      language: t.language ?? 'und',
      name: t.forced ? `${t.name} (forced)` : t.name,
      origin: 'creator-captions',
    }));
  },
  async getCaptions(ref, opts: CaptionOptions, ctx): Promise<Transcript | null> {
    const path = mediaPathOf(ref);
    if (!path) return null;
    const sidecars = findSidecars(path);
    const p = await probeIfAvailable(path, ctx);
    const spoken = p?.streams.find((s) => s.type === 'audio')?.language;
    const ranked = rankTracks([...sidecars, ...embeddedTracks(p)], opts.language, spoken);
    for (const track of ranked) {
      let segments: Segment[];
      try {
        segments = await readTrack(track, path, ctx);
      } catch (err) {
        ctx.log.warn('could not read subtitle track', {
          track: track.name,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (segments.length === 0) continue;
      ctx.log.info('using subtitles', { kind: track.kind, track: track.name });
      return {
        ref,
        language: track.language ?? spoken ?? 'und',
        origin: 'creator-captions',
        producer: 'media-file-captions',
        model: track.kind === 'sidecar' ? `sidecar:${track.name}` : `embedded:${track.streamIndex}`,
        segments,
        createdAt: new Date().toISOString(),
      };
    }
    return null;
  },
});
