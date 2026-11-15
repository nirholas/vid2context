/**
 * What a download request may ask for, and the one function every surface
 * (CLI, HTTP, MCP, web) uses to validate it. Runtime-neutral: no `node:*`.
 */
import { Vid2ContextError } from '@vid2context/core';
import { normalizeExtras } from './extras.ts';

export type MediaKind = 'video' | 'audio';

export const VIDEO_CONTAINERS = ['mp4', 'webm', 'mkv'] as const;
export type VideoContainer = (typeof VIDEO_CONTAINERS)[number];

export const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav'] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export type MediaFormat = VideoContainer | AudioFormat;

/** Largest picture size, as the smaller side in pixels (yt-dlp's `res`), or `best`. */
export const VIDEO_QUALITIES = ['best', '2160', '1440', '1080', '720', '480', '360', '240', '144'] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

/** mp3 bitrate in kbps, or `best` (VBR V0, about 245 kbps). Other formats keep or losslessly convert the source. */
export const AUDIO_QUALITIES = ['best', '320', '256', '192', '160', '128', '96', '64'] as const;
export type AudioQuality = (typeof AUDIO_QUALITIES)[number];

/** SponsorBlock categories yt-dlp can cut out of YouTube videos. */
export const SPONSOR_CATEGORIES = [
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
  'preview',
  'filler',
  'music_offtopic',
] as const;
export type SponsorCategory = (typeof SPONSOR_CATEGORIES)[number];

export const DEFAULT_VIDEO_FORMAT: VideoContainer = 'mp4';
export const DEFAULT_AUDIO_FORMAT: AudioFormat = 'mp3';
export const DEFAULT_VIDEO_QUALITY: VideoQuality = '1080';
export const DEFAULT_AUDIO_QUALITY: AudioQuality = 'best';

/** A validated download request. Build one with `normalizeRequest`. */
export interface DownloadRequest {
  /** A video URL, a YouTube id, or (CLI and MCP on this machine) a local file path. */
  input: string;
  kind: MediaKind;
  format: MediaFormat;
  quality: VideoQuality | AudioQuality;
  /** Start of the part to keep, in seconds. */
  fromSec?: number;
  /** End of the part to keep, in seconds. */
  toSec?: number;
  /** Keep one chapter: its 0-based index, or a title (exact, prefix, then substring, case-insensitive). */
  chapter?: string;
  /** Re-encode around the cut points so a trimmed video starts exactly at `fromSec` (slower). Default false. */
  exactCuts: boolean;
  /** Write title, artist (channel), date and description tags. Default true. */
  embedMetadata: boolean;
  /** Embed the thumbnail as cover art. Default true; ignored for webm and wav. */
  embedThumbnail: boolean;
  /** Write chapter markers. Default true; skipped when the file is trimmed and for wav. */
  embedChapters: boolean;
  /** Subtitle languages to embed in a video (creator or automatic), e.g. ['en']. Video only. */
  subtitles: string[];
  /** SponsorBlock categories to cut out (YouTube only). */
  removeSegments: SponsorCategory[];
  /** Burn this language's subtitles into the picture (video only, re-encodes). See extras.ts. */
  burnSubtitles?: string;
  /** Also write one file per chapter next to the full download. See extras.ts. */
  splitChapters?: boolean;
}

export const MIME_TYPES: Record<MediaFormat, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

export const FORMAT_LABELS: Record<MediaFormat, string> = {
  mp4: 'MP4 (H.264 + AAC, plays everywhere)',
  webm: 'WebM (VP9 + Opus)',
  mkv: 'MKV (best streams, any codec)',
  mp3: 'MP3',
  m4a: 'M4A (original AAC, no re-encode)',
  opus: 'Opus (original stream, no re-encode)',
  flac: 'FLAC (lossless container)',
  wav: 'WAV (uncompressed)',
};

export function isVideoContainer(v: string): v is VideoContainer {
  return (VIDEO_CONTAINERS as readonly string[]).includes(v);
}

export function isAudioFormat(v: string): v is AudioFormat {
  return (AUDIO_FORMATS as readonly string[]).includes(v);
}

export function kindOfFormat(format: MediaFormat): MediaKind {
  return isVideoContainer(format) ? 'video' : 'audio';
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

/**
 * Seconds from `83`, `83.5`, `1:23`, `1:02:03`, `90s`, `1m30s` or `1h2m3s`.
 * Returns undefined for an empty value; throws on anything else that does not parse.
 */
export function parseTime(value: unknown, label = 'time'): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0)
      throw bad(`${label} must be zero or more seconds.`, 'Pass seconds like 90, or 1:30.');
    return value;
  }
  if (typeof value !== 'string') throw bad(`${label} must be a number or a time string.`, 'Pass seconds like 90, or 1:30.');
  const s = value.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const colon = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (colon) {
    const [, h, m, sec] = colon;
    if (Number(sec) >= 60 || (h !== undefined && Number(m) >= 60)) {
      throw bad(`${label} "${value}" is not a valid time.`, 'Minutes and seconds go up to 59, e.g. 1:02:03.');
    }
    return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(sec);
  }
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (units && (units[1] || units[2] || units[3])) {
    return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }
  throw bad(
    `${label} "${String(value).slice(0, 40)}" is not a time.`,
    'Use seconds (90), m:ss (1:30), h:mm:ss (1:02:03) or 1m30s.',
  );
}

function bool(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
  }
  throw bad(`${label} must be true or false.`, `Pass ${label}=1 or ${label}=0.`);
}

function list(value: unknown, label: string): string[] {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (!items || items.some((v) => typeof v !== 'string')) throw bad(`${label} must be a list of strings.`, `Pass ${label}=a,b.`);
  return [...new Set((items as string[]).map((v) => v.trim()).filter(Boolean))];
}

const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/** Fields a caller may send. Strings are accepted everywhere so query strings and CLI flags work unchanged. */
export interface RawDownloadRequest {
  input?: unknown;
  url?: unknown;
  kind?: unknown;
  format?: unknown;
  quality?: unknown;
  from?: unknown;
  to?: unknown;
  chapter?: unknown;
  exactCuts?: unknown;
  embedMetadata?: unknown;
  embedThumbnail?: unknown;
  embedChapters?: unknown;
  subtitles?: unknown;
  removeSegments?: unknown;
  burnSubtitles?: unknown;
  splitChapters?: unknown;
}

/**
 * Validate and fill in defaults. `kind` may be left out when `format` says it
 * (mp3 means audio); with neither, the request is a video in mp4.
 */
export function normalizeRequest(raw: RawDownloadRequest): DownloadRequest {
  const input = typeof raw.input === 'string' ? raw.input.trim() : typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!input) throw bad('Missing the video to download.', 'Pass url (a video URL or YouTube id).');

  const formatRaw = typeof raw.format === 'string' ? raw.format.trim().toLowerCase().replace(/^\./, '') : undefined;
  const kindRaw = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : undefined;
  if (kindRaw !== undefined && kindRaw !== 'video' && kindRaw !== 'audio') {
    throw bad(`kind must be video or audio, not "${kindRaw.slice(0, 20)}".`, 'Pass kind=video or kind=audio.');
  }
  if (formatRaw !== undefined && formatRaw !== '' && !isVideoContainer(formatRaw) && !isAudioFormat(formatRaw)) {
    throw bad(
      `Unknown format "${formatRaw.slice(0, 20)}".`,
      `Video: ${VIDEO_CONTAINERS.join(', ')}. Audio: ${AUDIO_FORMATS.join(', ')}.`,
    );
  }
  const kind: MediaKind = (kindRaw as MediaKind | undefined) ?? (formatRaw ? kindOfFormat(formatRaw as MediaFormat) : 'video');
  const format: MediaFormat = formatRaw
    ? (formatRaw as MediaFormat)
    : kind === 'video'
      ? DEFAULT_VIDEO_FORMAT
      : DEFAULT_AUDIO_FORMAT;
  if (kindOfFormat(format) !== kind) {
    throw bad(
      `${format} is ${kindOfFormat(format) === 'video' ? 'a video' : 'an audio'} format, but kind is ${kind}.`,
      kind === 'video' ? `Video formats: ${VIDEO_CONTAINERS.join(', ')}.` : `Audio formats: ${AUDIO_FORMATS.join(', ')}.`,
    );
  }

  let quality: VideoQuality | AudioQuality;
  const qRaw =
    raw.quality === undefined || raw.quality === null || raw.quality === ''
      ? undefined
      : String(raw.quality)
          .trim()
          .toLowerCase()
          .replace(/(p|k|kbps)$/, '');
  if (kind === 'video') {
    quality = (qRaw ?? DEFAULT_VIDEO_QUALITY) as VideoQuality;
    if (!(VIDEO_QUALITIES as readonly string[]).includes(quality)) {
      throw bad(`Unknown video quality "${qRaw}".`, `Pick one of ${VIDEO_QUALITIES.join(', ')}.`);
    }
  } else {
    quality = (qRaw ?? DEFAULT_AUDIO_QUALITY) as AudioQuality;
    if (!(AUDIO_QUALITIES as readonly string[]).includes(quality)) {
      throw bad(`Unknown audio quality "${qRaw}".`, `Pick one of ${AUDIO_QUALITIES.join(', ')} (kbps; used by mp3).`);
    }
  }

  const fromSec = parseTime(raw.from, 'from');
  const toSec = parseTime(raw.to, 'to');
  if (fromSec !== undefined && toSec !== undefined && toSec <= fromSec) {
    throw bad(`to (${toSec} s) must be after from (${fromSec} s).`, 'Swap the values or widen the range.');
  }
  const chapter =
    raw.chapter === undefined || raw.chapter === null || raw.chapter === '' ? undefined : String(raw.chapter).trim();
  if (chapter !== undefined && (fromSec !== undefined || toSec !== undefined)) {
    throw bad('Pass either chapter or from/to, not both.', 'A chapter already sets the start and end.');
  }

  const subtitles = list(raw.subtitles, 'subtitles');
  for (const lang of subtitles) {
    if (!LANG.test(lang)) throw bad(`"${lang.slice(0, 20)}" is not a language code.`, 'Use codes like en, de or pt-BR.');
  }
  if (subtitles.length > 0 && kind !== 'video') {
    throw bad('Subtitles can only be embedded in video files.', 'Drop subtitles, or download a video.');
  }
  const removeSegments = list(raw.removeSegments, 'removeSegments');
  for (const cat of removeSegments) {
    if (!(SPONSOR_CATEGORIES as readonly string[]).includes(cat)) {
      throw bad(`Unknown SponsorBlock category "${cat.slice(0, 30)}".`, `Use ${SPONSOR_CATEGORIES.join(', ')}.`);
    }
  }

  return {
    input,
    kind,
    format,
    quality,
    ...(fromSec !== undefined ? { fromSec } : {}),
    ...(toSec !== undefined ? { toSec } : {}),
    ...(chapter !== undefined ? { chapter } : {}),
    exactCuts: bool(raw.exactCuts, false, 'exactCuts'),
    embedMetadata: bool(raw.embedMetadata, true, 'embedMetadata'),
    embedThumbnail: bool(raw.embedThumbnail, true, 'embedThumbnail'),
    embedChapters: bool(raw.embedChapters, true, 'embedChapters'),
    subtitles,
    removeSegments: removeSegments as SponsorCategory[],
    ...normalizeExtras(raw, { kind, trimmed: fromSec !== undefined || toSec !== undefined || chapter !== undefined }),
  };
}

/** Whether the request keeps only part of the video. */
export function isTrimmed(req: Pick<DownloadRequest, 'fromSec' | 'toSec' | 'chapter'>): boolean {
  return req.fromSec !== undefined || req.toSec !== undefined || req.chapter !== undefined;
}

/** Find a chapter by 0-based index or by title (exact, prefix, then substring, case-insensitive). */
export function findChapter<T extends { title: string }>(
  chapters: T[],
  query: string,
): { chapter: T; index: number } | undefined {
  if (/^\d+$/.test(query)) {
    const index = Number(query);
    const chapter = chapters[index];
    return chapter ? { chapter, index } : undefined;
  }
  const q = query.toLowerCase();
  const tests: ((t: string) => boolean)[] = [(t) => t === q, (t) => t.startsWith(q), (t) => t.includes(q)];
  for (const test of tests) {
    const index = chapters.findIndex((c) => test(c.title.toLowerCase()));
    if (index >= 0) return { chapter: chapters[index] as T, index };
  }
  return undefined;
}

/** "1:02:03" or "2:03" for a filename suffix and messages. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}
