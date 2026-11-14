/**
 * Subtitle track choice and download through yt-dlp.
 *
 * Tracks come from the info JSON: `subtitles` are uploaded by the creator,
 * `automatic_captions` are the site's speech recognition. yt-dlp marks the
 * original-language automatic track with an `-orig` suffix on YouTube;
 * automatic tracks in other languages are machine translations of it.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  type CaptionOptions,
  type CaptionTrackInfo,
  type Ctx,
  type Transcript,
  Vid2ContextError,
  type VideoRef,
} from '@vid2context/core';
import { subtitleArgs } from './args.ts';
import type { YtDlpInfo, YtDlpSubtitle } from './info.ts';
import { fetchInfo, prepare, ytdlp } from './run.ts';
import { parseVtt } from './vtt.ts';

/** Formats the parser reads directly, or that yt-dlp converts to WebVTT with ffmpeg. */
const TEXT_FORMATS = new Set(['vtt', 'srt', 'ass', 'ssa', 'ttml', 'dfxp', 'srv1', 'srv2', 'srv3', 'json3']);
const IGNORED = /^(live_chat|rechat|danmaku|comments)$/i;

export interface SubtitleChoice {
  /** The exact key yt-dlp uses for --sub-langs. */
  key: string;
  /** BCP-47 language of the text. */
  language: string;
  auto: boolean;
  translated: boolean;
}

const primary = (code: string): string => code.toLowerCase().split(/[-_]/)[0] ?? '';
const languageOf = (key: string): string => key.replace(/-orig$/i, '');

function usableKeys(tracks: Record<string, YtDlpSubtitle[]> | null | undefined): string[] {
  return Object.entries(tracks ?? {})
    .filter(([key, formats]) => !IGNORED.test(key) && formats.some((f) => !f.ext || TEXT_FORMATS.has(f.ext)))
    .map(([key]) => key);
}

function byLanguage(keys: string[], language: string): string | undefined {
  const want = language.toLowerCase();
  return (
    keys.find((k) => languageOf(k).toLowerCase() === want) ??
    keys.find((k) => k.toLowerCase() === `${want}-orig`) ??
    keys.find((k) => primary(languageOf(k)) === primary(want))
  );
}

/** Pick the best subtitle track for the options, or null when there is none. */
export function chooseSubtitle(info: YtDlpInfo, opts: CaptionOptions): SubtitleChoice | null {
  const allowAuto = opts.allowAuto ?? true;
  const allowTranslated = opts.allowTranslated ?? true;
  const creator = usableKeys(info.subtitles);
  const auto = allowAuto ? usableKeys(info.automatic_captions) : [];
  const origKey = auto.find((k) => /-orig$/i.test(k));
  const spoken = info.language ?? (origKey ? languageOf(origKey) : undefined);

  const pick = (key: string, isAuto: boolean): SubtitleChoice => {
    const language = languageOf(key);
    // An automatic track in a language other than the spoken one is a machine translation.
    const translated = isAuto && Boolean(spoken) && primary(language) !== primary(spoken ?? '') && !/-orig$/i.test(key);
    return { key, language, auto: isAuto, translated };
  };
  const ok = (c: SubtitleChoice) => allowTranslated || !c.translated;

  if (opts.language) {
    const c = byLanguage(creator, opts.language);
    if (c) return pick(c, false);
    const a = byLanguage(auto, opts.language);
    if (a && ok(pick(a, true))) return pick(a, true);
    return null;
  }
  const c = (spoken ? byLanguage(creator, spoken) : undefined) ?? byLanguage(creator, 'en') ?? creator[0];
  if (c) return pick(c, false);
  const a = origKey ?? (spoken ? byLanguage(auto, spoken) : undefined) ?? (auto.length === 1 ? auto[0] : undefined);
  if (a && ok(pick(a, true))) return pick(a, true);
  return null;
}

export function listTracks(info: YtDlpInfo): CaptionTrackInfo[] {
  const creator = usableKeys(info.subtitles).map(
    (key): CaptionTrackInfo => ({
      language: languageOf(key),
      name: info.subtitles?.[key]?.[0]?.name ?? key,
      origin: 'creator-captions',
    }),
  );
  const auto = usableKeys(info.automatic_captions).map(
    (key): CaptionTrackInfo => ({
      language: languageOf(key),
      name: info.automatic_captions?.[key]?.[0]?.name ?? key,
      origin: 'auto-captions',
    }),
  );
  return [...creator, ...auto];
}

/** Download the chosen track and parse it. */
export async function getCaptions(ref: VideoRef, opts: CaptionOptions, ctx: Ctx): Promise<Transcript | null> {
  const { info, url } = await fetchInfo(ref, ctx);
  const choice = chooseSubtitle(info, opts);
  if (!choice) return null;
  const { bin, cfg } = await prepare(ctx);
  const dir = await mkdtemp(join(tmpdir(), 'vid2context-ytdlp-subs-'));
  try {
    const args = subtitleArgs(url, cfg, { language: choice.key, auto: choice.auto, outTemplate: join(dir, 'sub.%(ext)s') });
    await ytdlp(ctx, bin.path, args, 'captions', dir);
    const files = (await readdir(dir)).filter((f) => f.startsWith('sub.'));
    const file = files.find((f) => extname(f) === '.vtt') ?? files.find((f) => extname(f) === '.srt');
    if (!file) {
      if (files.length === 0) return null;
      throw new Vid2ContextError(
        'upstream',
        `yt-dlp saved subtitles as ${files.map(extname).join(', ')}, which cannot be read.`,
        {
          hint: 'Install ffmpeg (or set FFMPEG_PATH) so yt-dlp can convert the subtitles to WebVTT.',
        },
      );
    }
    const segments = parseVtt(await readFile(join(dir, file), 'utf8'));
    if (segments.length === 0) return null;
    return {
      ref,
      language: choice.language,
      origin: choice.auto ? 'auto-captions' : 'creator-captions',
      producer: 'ytdlp-captions',
      ...(choice.translated ? { translated: true } : {}),
      segments,
      createdAt: new Date().toISOString(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
