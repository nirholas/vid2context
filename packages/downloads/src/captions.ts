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
import { formatters, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { toolkitLimits } from './limits.ts';

/** `original` keeps the file as the site (or the local sidecar) has it. */
export const CAPTION_FORMATS = ['srt', 'vtt', 'txt', 'json', 'markdown', 'original'] as const;
export type CaptionFormat = (typeof CAPTION_FORMATS)[number];

/** auto: captions, else speech-to-text. captions: never transcribe. stt: always transcribe. */
export const CAPTION_MODES = ['auto', 'captions', 'stt'] as const;
export type CaptionMode = (typeof CAPTION_MODES)[number];

/** Which path fetches the text. auto: the pipeline, then yt-dlp (yt-dlp first for `original`). */
export const CAPTION_VIA = ['auto', 'pipeline', 'ytdlp'] as const;
export type CaptionVia = (typeof CAPTION_VIA)[number];

export const CAPTION_FORMAT_LABELS: Record<CaptionFormat, string> = {
  srt: 'SubRip (.srt)',
  vtt: 'WebVTT (.vtt)',
  txt: 'Plain text (.txt)',
  json: 'JSON segments (.json)',
  markdown: 'Markdown transcript (.md)',
  original: 'Original file as the site serves it',
};

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
  formats: { id: CaptionFormat; label: string }[];
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
  const alias = v === 'text' || v === 'plain' ? 'txt' : v === 'md' ? 'markdown' : v === 'webvtt' ? 'vtt' : v;
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
  };
}

export interface RenderedCaptions {
  text: string;
  /** File extension without the dot. */
  ext: string;
  mimeType: string;
}

/** The JSON caption format: the transcript's segments with where they came from. */
export function captionsJson(context: VideoContext): string {
  const { metadata: m, transcript: t } = context;
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
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Render a transcript in a converted caption format (everything but `original`). */
export function renderCaptions(
  context: VideoContext,
  format: Exclude<CaptionFormat, 'original'>,
  opts: { timestamps?: boolean } = {},
): RenderedCaptions {
  switch (format) {
    case 'json':
      return { text: captionsJson(context), ext: 'json', mimeType: 'application/json' };
    case 'txt': {
      const f = formatters.text as (typeof formatters)[string];
      return { text: f.render(context, { timestamps: opts.timestamps ?? false }), ext: 'txt', mimeType: f.mimeType };
    }
    case 'markdown': {
      const f = formatters.markdown as (typeof formatters)[string];
      return { text: f.render(context, {}), ext: 'md', mimeType: f.mimeType };
    }
    default: {
      const f = formatters[format] as (typeof formatters)[string];
      return { text: f.render(context, {}), ext: f.extension, mimeType: f.mimeType };
    }
  }
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
