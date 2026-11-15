/**
 * Captions-only downloads: which tracks a video has, the request every
 * surface validates with `normalizeCaptionsRequest`, and the conversion of a
 * transcript into srt, vtt, txt, json or Markdown through core's formatters.
 * Runtime-neutral: no `node:*`. The Node side is node/captions.ts.
 *
 * Two paths produce the text:
 *   - the transcript pipeline (`getVideoContext`, mode captions or stt): any
 *     source vid2context reads, with speech-to-text for videos without
 *     captions, and no yt-dlp needed
 *   - yt-dlp's subtitle download, for the original file as the site serves it
 *     (srv3, vtt, ttml) and as a second path when the pipeline fails
 */
import {
  type FormatOptions,
  formatters,
  LINE_CHARS_RANGE,
  LINES_RANGE,
  shiftSegments,
  type Transcript,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { toolkitLimits } from './limits.ts';

/**
 * Caption formats, derived from core's `formatters` so a subtitle format added
 * there shows up here (and in the CLI, MCP and HTTP lists) without changes:
 * every formatter whose times are subtitle times (`timed: 'always'`: srt, vtt,
 * ass, ttml, sbv, lrc, csv, ...), then txt (core's text), json (timed segments),
 * markdown, and `original`, which keeps the file as the site (or the local
 * sidecar) has it. srt is first and the default.
 */
function captionFormatIds(): string[] {
  const timed = Object.values(formatters)
    .filter((f) => f.timed === 'always')
    .map((f) => f.id)
    .sort((a, b) => Number(b === 'srt') - Number(a === 'srt'));
  return [...timed, 'txt', 'json', 'markdown', 'original'];
}

export const CAPTION_FORMATS: readonly string[] = captionFormatIds();
/** One of CAPTION_FORMATS. */
export type CaptionFormat = string;

/** Short labels for the formats this package defines; core formats use their own description. */
const OWN_LABELS: Record<string, string> = {
  txt: 'Plain text (.txt), with [m:ss] lines when timestamps is on',
  json: 'JSON segments (.json): start, end, text, speaker, with language and origin',
  markdown: 'Markdown transcript (.md)',
  original: 'Original file as the site (or the local sidecar) has it',
};

export function captionFormatLabel(id: string): string {
  return OWN_LABELS[id] ?? formatters[id]?.description ?? id;
}

/** `[{ id, label }]` for every caption format, for the status route, the track list and tool descriptions. */
export function captionFormatList(): { id: string; label: string; timed: boolean; bilingual: boolean }[] {
  return CAPTION_FORMATS.map((id) => {
    const core = formatters[id === 'txt' ? 'text' : id];
    return {
      id,
      label: captionFormatLabel(id),
      timed: id === 'json' || id === 'txt' || core?.timed === 'always',
      bilingual: id === 'json' || core?.bilingual === true,
    };
  });
}

/** @deprecated Use captionFormatLabel(id); kept as a map for callers that index it. */
export const CAPTION_FORMAT_LABELS: Record<string, string> = Object.fromEntries(
  CAPTION_FORMATS.map((id) => [id, captionFormatLabel(id)]),
);

/** auto: captions, else speech-to-text. captions: never transcribe. stt: always transcribe. */
export const CAPTION_MODES = ['auto', 'captions', 'stt'] as const;
export type CaptionMode = (typeof CAPTION_MODES)[number];

/** Which path fetches the text. auto: the pipeline, then yt-dlp (yt-dlp first for `original`). */
export const CAPTION_VIA = ['auto', 'pipeline', 'ytdlp'] as const;
export type CaptionVia = (typeof CAPTION_VIA)[number];

export interface CaptionsRequest {
  kind: 'captions';
  /** A video URL, a YouTube id, or (CLI and MCP on this machine) a local file path. */
  input: string;
  /** BCP-47 codes. Empty with `allLanguages` false: the spoken language (or the best track). */
  languages: string[];
  /** Every listed track (creator and automatic originals; not the machine-translation targets). */
  allLanguages: boolean;
  format: CaptionFormat;
  mode: CaptionMode;
  via: CaptionVia;
  /** Accept the platform's automatic captions. Default true. */
  allowAuto: boolean;
  /** Accept the platform's machine translation into a requested language. Default true. */
  allowTranslated: boolean;
  /** txt only: one "[m:ss] line" per caption. Default false. */
  timestamps: boolean;
  /** Pack the result in a .zip even when it is one file. Several files are always zipped. */
  zip: boolean;
  /** Shift every cue by this many seconds (negative: earlier). Timed formats only. */
  offsetSec?: number;
  /** Longest caption line in characters for the cue formats (core's range, 10 to 200). */
  maxLineChars?: number;
  /** Most lines per cue for the cue formats (1 to 4). */
  maxLines?: number;
  /** A second language shown under each caption (bilingual output), fetched like the primary. */
  secondary?: string;
}

export interface RawCaptionsRequest {
  input?: unknown;
  url?: unknown;
  languages?: unknown;
  /** Alias of languages for query strings: lang=en,de or lang=all. */
  lang?: unknown;
  allLanguages?: unknown;
  format?: unknown;
  mode?: unknown;
  via?: unknown;
  allowAuto?: unknown;
  allowTranslated?: unknown;
  timestamps?: unknown;
  zip?: unknown;
  offsetSec?: unknown;
  /** Alias of offsetSec for query strings and CLI flags. */
  offset?: unknown;
  maxLineChars?: unknown;
  maxLines?: unknown;
  secondary?: unknown;
}

/** One caption track a video offers. */
export interface CaptionTrack {
  /** BCP-47 code, as you pass it in `languages`. */
  language: string;
  /** Readable name, e.g. "English", "German (auto-generated)". */
  name: string;
  /** False: written by the creator. True: the platform's speech recognition. */
  auto: boolean;
  origin: 'creator-captions' | 'auto-captions' | 'native-transcript';
  /** Who lists it: captions provider ids, and "ytdlp" for yt-dlp's info. */
  sources: string[];
  /** The platform can machine-translate this track into `translationTargets`. */
  translatable?: boolean;
}

export interface CaptionTracks {
  input: string;
  id?: string;
  title?: string;
  url?: string;
  tracks: CaptionTrack[];
  /** Languages the platform can machine-translate into (YouTube); pass one in `languages`. */
  translationTargets: { language: string; name: string }[];
  /** Speech-to-text can make a transcript when there are no tracks (mode auto or stt). */
  speechToText: boolean;
  formats: { id: CaptionFormat; label: string; timed: boolean; bilingual: boolean }[];
  /** Why a list is short or empty, which path failed. */
  notes: string[];
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function flag(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
  }
  throw bad(`${label} must be true or false.`, `Pass ${label}=1 or ${label}=0.`);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  const alias =
    v === 'text' || v === 'plain' ? 'txt' : v === 'md' ? 'markdown' : v === 'webvtt' ? 'vtt' : v === 'subrip' ? 'srt' : v;
  if (!(allowed as readonly string[]).includes(alias)) {
    throw bad(`Unknown ${label} "${v.slice(0, 20)}".`, `Use ${allowed.join(', ')}.`);
  }
  return alias as T;
}

const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/** Validate a captions request and fill in defaults. `env` applies the track limit. */
export function normalizeCaptionsRequest(raw: RawCaptionsRequest, env: Record<string, string | undefined> = {}): CaptionsRequest {
  const input = typeof raw.input === 'string' ? raw.input.trim() : typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!input) throw bad('Missing the video to read captions from.', 'Pass url (a video URL, YouTube id or file path).');
  const langRaw = raw.languages ?? raw.lang;
  const items = Array.isArray(langRaw)
    ? langRaw
    : typeof langRaw === 'string'
      ? langRaw.split(',')
      : langRaw === undefined || langRaw === null
        ? []
        : null;
  if (!items || items.some((v) => typeof v !== 'string')) {
    throw bad('languages must be a list of language codes.', 'Pass languages=en,de or ["en","de"], or all.');
  }
  let all = flag(raw.allLanguages, false, 'allLanguages');
  const languages: string[] = [];
  for (const item of items as string[]) {
    const v = item.trim();
    if (!v) continue;
    if (v.toLowerCase() === 'all') {
      all = true;
      continue;
    }
    if (!LANG.test(v)) throw bad(`"${v.slice(0, 20)}" is not a language code.`, 'Use codes like en, de or pt-BR, or all.');
    if (!languages.some((l) => l.toLowerCase() === v.toLowerCase())) languages.push(v);
  }
  const max = toolkitLimits(env).maxCaptionTracks;
  if (languages.length > max) {
    throw bad(
      `${languages.length} languages asked; the limit is ${max}.`,
      'Ask for fewer, or raise VID2CONTEXT_MAX_CAPTION_TRACKS.',
    );
  }
  const format = pick(raw.format, CAPTION_FORMATS, 'srt', 'caption format');
  const mode = pick(raw.mode, CAPTION_MODES, 'auto', 'mode');
  const via = pick(raw.via, CAPTION_VIA, 'auto', 'via');
  if (format === 'original' && mode === 'stt') {
    throw bad('Speech-to-text output has no original file.', 'Pick srt, vtt, txt, json or markdown with mode stt.');
  }
  if (via === 'ytdlp' && mode === 'stt') {
    throw bad('yt-dlp downloads existing captions; it does not transcribe.', 'Use via=pipeline (or auto) with mode stt.');
  }
  const offsetRaw = raw.offsetSec ?? raw.offset;
  let offsetSec: number | undefined;
  if (offsetRaw !== undefined && offsetRaw !== null && offsetRaw !== '') {
    offsetSec = typeof offsetRaw === 'number' ? offsetRaw : Number(String(offsetRaw).trim().replace(/s$/i, ''));
    if (!Number.isFinite(offsetSec) || Math.abs(offsetSec) > 86_400) {
      throw bad(
        `offset "${String(offsetRaw).slice(0, 20)}" is not a number of seconds.`,
        'Pass seconds, e.g. 2.5 (later) or -1 (earlier).',
      );
    }
    if (offsetSec === 0) offsetSec = undefined;
  }
  const range = (value: unknown, label: string, r: { min: number; max: number }): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < r.min || n > r.max) {
      throw bad(`${label} must be a whole number from ${r.min} to ${r.max}.`, `Pass ${label}=${r.min === 1 ? 2 : 42}.`);
    }
    return n;
  };
  const maxLineChars = range(raw.maxLineChars, 'maxLineChars', LINE_CHARS_RANGE);
  const maxLines = range(raw.maxLines, 'maxLines', LINES_RANGE);
  let secondary: string | undefined;
  if (raw.secondary !== undefined && raw.secondary !== null && raw.secondary !== '') {
    secondary = String(raw.secondary).trim();
    if (!LANG.test(secondary))
      throw bad(`secondary "${secondary.slice(0, 20)}" is not a language code.`, 'Use a code like de or pt-BR.');
  }
  const core = formatters[format === 'txt' ? 'text' : format];
  if (format === 'original' && (offsetSec !== undefined || secondary || maxLineChars || maxLines)) {
    throw bad(
      'The original file is saved as the site serves it, so it cannot be retimed, rewrapped or made bilingual.',
      'Pick a converted format (srt, vtt, ...) for offset, maxLineChars, maxLines or secondary.',
    );
  }
  if (offsetSec !== undefined && format === 'markdown') {
    throw bad(
      'markdown timestamps are links into the video, so they are not shifted.',
      'Use a timed format (srt, vtt, txt, json, ...).',
    );
  }
  if (secondary && format !== 'json' && !core?.bilingual) {
    const bi = captionFormatList()
      .filter((f) => f.bilingual)
      .map((f) => f.id);
    throw bad(`${format} cannot show a second language.`, `Bilingual formats: ${bi.join(', ')}.`);
  }
  if (secondary && languages.some((l) => l.toLowerCase() === secondary?.toLowerCase())) {
    throw bad('secondary is the same as a requested language.', 'Pick a different second language.');
  }
  return {
    kind: 'captions',
    input,
    languages,
    allLanguages: all,
    format,
    mode,
    via,
    allowAuto: flag(raw.allowAuto, true, 'allowAuto'),
    allowTranslated: flag(raw.allowTranslated, true, 'allowTranslated'),
    timestamps: flag(raw.timestamps, false, 'timestamps'),
    zip: flag(raw.zip, false, 'zip'),
    ...(offsetSec !== undefined ? { offsetSec } : {}),
    ...(maxLineChars !== undefined ? { maxLineChars } : {}),
    ...(maxLines !== undefined ? { maxLines } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

/** The rendering options of a request: offset, line layout and the second-language transcript. */
export type CaptionRenderOptions = Pick<FormatOptions, 'timestamps' | 'offsetSec' | 'maxLineChars' | 'maxLines' | 'secondary'>;

export interface RenderedCaptions {
  text: string;
  /** File extension without the dot. */
  ext: string;
  mimeType: string;
}

/** The JSON caption format: the transcript's segments with where they came from. */
export function captionsJson(context: VideoContext, opts: CaptionRenderOptions = {}): string {
  const { metadata: m } = context;
  const off = opts.offsetSec;
  const t = off ? { ...context.transcript, segments: shiftSegments(context.transcript.segments, off) } : context.transcript;
  const second: Transcript | undefined =
    opts.secondary && off ? { ...opts.secondary, segments: shiftSegments(opts.secondary.segments, off) } : opts.secondary;
  const body = {
    title: m.title,
    url: m.ref.url ?? m.ref.input,
    language: t.language,
    origin: t.origin,
    producer: t.producer,
    ...(t.model ? { model: t.model } : {}),
    ...(t.translated ? { translated: true } : {}),
    segments: t.segments.map((s) => ({
      startSec: s.startSec,
      endSec: s.endSec,
      text: s.text,
      ...(s.speaker ? { speaker: s.speaker } : {}),
    })),
    ...(off ? { offsetSec: off } : {}),
    ...(second
      ? {
          secondary: {
            language: second.language,
            origin: second.origin,
            producer: second.producer,
            ...(second.translated ? { translated: true } : {}),
            segments: second.segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text })),
          },
        }
      : {}),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Render a transcript in a converted caption format (everything but `original`). */
export function renderCaptions(context: VideoContext, format: CaptionFormat, opts: CaptionRenderOptions = {}): RenderedCaptions {
  if (format === 'json') return { text: captionsJson(context, opts), ext: 'json', mimeType: 'application/json' };
  const id = format === 'txt' ? 'text' : format;
  const f = formatters[id];
  if (!f || format === 'original' || id === 'pack') {
    throw bad(
      `Unknown caption format "${format.slice(0, 20)}".`,
      `Use ${CAPTION_FORMATS.filter((x) => x !== 'original').join(', ')}.`,
    );
  }
  const o: FormatOptions = {
    ...(format === 'txt' ? { timestamps: opts.timestamps ?? false } : {}),
    ...(opts.offsetSec !== undefined && f.timed ? { offsetSec: opts.offsetSec } : {}),
    ...(opts.maxLineChars !== undefined ? { maxLineChars: opts.maxLineChars } : {}),
    ...(opts.maxLines !== undefined ? { maxLines: opts.maxLines } : {}),
    ...(opts.secondary && f.bilingual ? { secondary: opts.secondary } : {}),
  };
  return { text: f.render(context, o), ext: format === 'markdown' ? 'md' : f.extension, mimeType: f.mimeType };
}

/** Mime type for an original subtitle file extension. */
export function subtitleMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'vtt':
      return 'text/vtt; charset=utf-8';
    case 'srt':
      return 'application/x-subrip; charset=utf-8';
    case 'json3':
    case 'json':
      return 'application/json';
    case 'ttml':
    case 'dfxp':
    case 'srv1':
    case 'srv2':
    case 'srv3':
    case 'xml':
      return 'application/xml';
    case 'ass':
    case 'ssa':
      return 'text/x-ssa; charset=utf-8';
    default:
      return 'text/plain; charset=utf-8';
  }
}
