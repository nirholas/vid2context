/**
 * Extras on top of a plain download, runtime-neutral (no `node:*`):
 *
 * - a thumbnail (cover image) saved as its own file, in jpg, png or webp
 * - subtitles burned into the picture, for players and sites that ignore
 *   subtitle tracks (one language, re-encodes the video)
 * - one file per chapter, next to the full download
 *
 * The Node side lives in `node/extras.ts`; this file holds validation and the
 * pure helpers (picking a thumbnail, shifting subtitle times, planning the
 * chapter parts) so tests can check them without ffmpeg.
 */
import { Vid2ContextError } from '@vid2context/core';

export const THUMBNAIL_FORMATS = ['jpg', 'png', 'webp'] as const;
export type ThumbnailFormat = (typeof THUMBNAIL_FORMATS)[number];
export const DEFAULT_THUMBNAIL_FORMAT: ThumbnailFormat = 'jpg';

export const THUMBNAIL_MIME_TYPES: Record<ThumbnailFormat, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

export interface ThumbnailRequest {
  /** A video URL, a YouTube id, or (CLI and MCP on this machine) a local file path. */
  input: string;
  format: ThumbnailFormat;
}

export interface RawThumbnailRequest {
  input?: unknown;
  url?: unknown;
  format?: unknown;
}

export function normalizeThumbnailRequest(raw: RawThumbnailRequest): ThumbnailRequest {
  const input = typeof raw.input === 'string' ? raw.input.trim() : typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!input) throw bad('Missing the video to take the thumbnail from.', 'Pass url (a video URL or YouTube id).');
  const f =
    raw.format === undefined || raw.format === null || raw.format === ''
      ? DEFAULT_THUMBNAIL_FORMAT
      : String(raw.format)
          .trim()
          .toLowerCase()
          .replace(/^\./, '')
          .replace(/^jpeg$/, 'jpg');
  if (!(THUMBNAIL_FORMATS as readonly string[]).includes(f)) {
    throw bad(`Unknown thumbnail format "${f.slice(0, 20)}".`, `Pick one of ${THUMBNAIL_FORMATS.join(', ')}.`);
  }
  return { input, format: f as ThumbnailFormat };
}

/** One entry of yt-dlp's `thumbnails` list. */
export interface ThumbnailCandidate {
  url?: string;
  width?: number | null;
  height?: number | null;
  preference?: number | null;
  id?: string;
}

/**
 * The largest thumbnail yt-dlp listed: biggest picture first, then yt-dlp's
 * own preference, then the later entry (yt-dlp sorts worst to best). Falls
 * back to the single `thumbnail` field.
 */
export function pickThumbnail(
  thumbnails: ThumbnailCandidate[] | null | undefined,
  fallback?: string | null,
): { url: string; width?: number; height?: number } | undefined {
  const list = (thumbnails ?? [])
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => typeof t.url === 'string' && /^https?:\/\//i.test(t.url));
  if (list.length > 0) {
    const area = (t: ThumbnailCandidate) => (t.width ?? 0) * (t.height ?? 0);
    list.sort((a, b) => area(b.t) - area(a.t) || (b.t.preference ?? -1e9) - (a.t.preference ?? -1e9) || b.i - a.i);
    const best = (list[0] as { t: ThumbnailCandidate }).t;
    return {
      url: best.url as string,
      ...(best.width ? { width: best.width } : {}),
      ...(best.height ? { height: best.height } : {}),
    };
  }
  return fallback && /^https?:\/\//i.test(fallback) ? { url: fallback } : undefined;
}

/** The image type from its first bytes, or undefined when it is none of jpg, png, webp. */
export function sniffImage(bytes: Uint8Array): ThumbnailFormat | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'webp';
  }
  return undefined;
}

/** The extra request fields, validated against the rest of the request. */
export interface DownloadExtras {
  /** Burn this language's subtitles into the picture (video only, re-encodes). */
  burnSubtitles?: string;
  /** Also write one file per chapter, in a folder next to the full download. */
  splitChapters?: boolean;
}

export function normalizeExtras(
  raw: { burnSubtitles?: unknown; splitChapters?: unknown },
  req: { kind: string; trimmed: boolean },
): DownloadExtras {
  const out: DownloadExtras = {};
  if (raw.burnSubtitles !== undefined && raw.burnSubtitles !== null && raw.burnSubtitles !== '') {
    if (typeof raw.burnSubtitles !== 'string') throw bad('burnSubtitles must be a language code.', 'Pass burnSubtitles=en.');
    const lang = raw.burnSubtitles.trim();
    if (!LANG.test(lang)) throw bad(`"${lang.slice(0, 20)}" is not a language code.`, 'Use codes like en, de or pt-BR.');
    if (req.kind !== 'video')
      throw bad('Subtitles can only be burned into video files.', 'Drop burnSubtitles, or download a video.');
    out.burnSubtitles = lang;
  }
  const split = raw.splitChapters;
  if (split !== undefined && split !== null && split !== '') {
    let on: boolean;
    if (typeof split === 'boolean') on = split;
    else if (typeof split === 'string' && ['1', 'true', 'yes', 'on'].includes(split.trim().toLowerCase())) on = true;
    else if (typeof split === 'string' && ['0', 'false', 'no', 'off'].includes(split.trim().toLowerCase())) on = false;
    else throw bad('splitChapters must be true or false.', 'Pass splitChapters=1 or splitChapters=0.');
    if (on && req.trimmed) {
      throw bad(
        'splitChapters downloads the whole video, so it cannot be combined with chapter, from or to.',
        'Drop one of them.',
      );
    }
    if (on) out.splitChapters = true;
  }
  return out;
}

/** One chapter of a split, in seconds of the downloaded file. */
export interface ChapterPart {
  index: number;
  title: string;
  fromSec: number;
  toSec: number;
}

/**
 * The parts a chapter split writes. Chapters without a start are dropped, an
 * end comes from the next chapter or the duration, and parts shorter than
 * half a second (chapter lists that repeat a start time) are skipped.
 */
export function chapterParts(
  chapters: { start_time?: number; end_time?: number; title?: string }[] | null | undefined,
  durationSec: number | undefined,
): ChapterPart[] {
  const list = (chapters ?? [])
    .filter((c) => typeof c.start_time === 'number' && Number.isFinite(c.start_time))
    .sort((a, b) => (a.start_time as number) - (b.start_time as number));
  const parts: ChapterPart[] = [];
  list.forEach((c, i) => {
    const fromSec = Math.max(0, c.start_time as number);
    const next = list[i + 1]?.start_time;
    const end = typeof c.end_time === 'number' ? c.end_time : (next ?? durationSec);
    if (end === undefined) return;
    const toSec = durationSec !== undefined ? Math.min(end, durationSec) : end;
    if (toSec - fromSec < 0.5) return;
    parts.push({ index: parts.length, title: c.title?.trim() || `Chapter ${parts.length + 1}`, fromSec, toSec });
  });
  return parts;
}

/** "01 - Intro.mp4": numbered so a file manager lists the parts in order. */
export function partName(part: ChapterPart, total: number, ext: string, safe: (s: string, max: number) => string): string {
  const width = Math.max(2, String(total).length);
  const n = String(part.index + 1).padStart(width, '0');
  return `${n} - ${safe(part.title, 150)}.${ext}`;
}

function parseClock(t: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(t.trim());
  if (!m) return Number.NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] as string).padEnd(3, '0')) / 1000;
}

function srtClock(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (v: number, n = 2) => String(v).padStart(n, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/**
 * Move SRT or WebVTT cues so `fromSec` of the source becomes 0, drop cues
 * outside the kept part, clip the ones on its edges, and renumber. Returns
 * SRT, which both ffmpeg's subtitles filter and every player read.
 */
export function shiftSubtitles(text: string, fromSec: number, toSec?: number): string {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = (lines[at] as string).split('-->');
    const start = parseClock((a ?? '').trim());
    const end = parseClock((b ?? '').trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (end <= fromSec || (toSec !== undefined && start >= toSec)) continue;
    const s = Math.max(start, fromSec) - fromSec;
    const e = (toSec !== undefined ? Math.min(end, toSec) : end) - fromSec;
    // WebVTT voice and styling tags would show up as literal text once burned in.
    const body = lines
      .slice(at + 1)
      .map((l) => l.replace(/<\/?(?:v|c|i|b|u|lang)(?:[ .][^>]*)?>/g, '').replace(/<\d{2}:\d{2}[^>]*>/g, ''))
      .filter((l) => l.trim() !== '');
    if (body.length === 0) continue;
    out.push(`${out.length + 1}\n${srtClock(s)} --> ${srtClock(e)}\n${body.join('\n')}`);
  }
  return out.length > 0 ? `${out.join('\n\n')}\n` : '';
}
