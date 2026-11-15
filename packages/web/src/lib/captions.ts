/**
 * Captions only, without the rest of the context: list a video's caption
 * tracks (GET /caption-languages), then fetch one track in a subtitle or text
 * format (GET /transcript?lang=&format=&mode=captions), or every track at
 * once as a .zip. mode=captions means no audio is ever downloaded or
 * transcribed for these files: a track either exists or the call says so.
 */
import { zipStream } from '@vid2context/core';
import { apiBase, apiUrl, type CallOptions, requestJson, unreachable } from './api.ts';
import { streamToBlob } from './download.ts';
import { fromApiBody, isAbort, isApiErrorBody } from './errors.ts';

export type CaptionOrigin = 'creator-captions' | 'auto-captions' | 'native-transcript';

/** One track as the API lists it: every provider that offers a track lists it, so the same track can appear twice. */
export interface RawCaptionTrack {
  language: string;
  name: string;
  origin: CaptionOrigin;
  translatable?: boolean;
  provider: string;
}

export interface CaptionLanguagesResponse {
  videoId: string;
  url?: string;
  tracks: RawCaptionTrack[];
  translationTargets: { language: string; name: string }[];
  notes: string[];
}

/**
 * One language once the providers' duplicates are merged. GET /transcript
 * picks the best track in a language (creator captions, then a published
 * transcript, then auto-captions), so that is the one a download returns;
 * `origins` lists every kind the platform has in the language.
 */
export interface CaptionTrack {
  language: string;
  name: string;
  /** The kind a download returns: the best of `origins`. */
  origin: CaptionOrigin;
  origins: CaptionOrigin[];
  translatable: boolean;
  /** Every provider that lists it, in the order the server gave. */
  providers: string[];
}

const ORIGIN_RANK: Record<CaptionOrigin, number> = { 'creator-captions': 0, 'native-transcript': 1, 'auto-captions': 2 };

export const ORIGIN_LABELS: Record<CaptionOrigin, string> = {
  'creator-captions': 'Creator captions',
  'native-transcript': 'Published transcript',
  'auto-captions': 'Auto-captions',
};

/** A name that is more than the bare code ("English" over "en"). */
function betterName(a: string, b: string, language: string): string {
  const bare = (n: string) => !n.trim() || n.trim().toLowerCase() === language.toLowerCase();
  return bare(a) && !bare(b) ? b : a;
}

/**
 * Merge the tracks several providers list into one entry per language, best
 * first: languages with creator captions, then published transcripts, then
 * auto-captions only, each group by name.
 */
export function mergeTracks(raw: RawCaptionTrack[]): CaptionTrack[] {
  const byLang = new Map<string, CaptionTrack>();
  for (const t of raw) {
    const key = t.language.toLowerCase();
    const seen = byLang.get(key);
    if (!seen) {
      byLang.set(key, {
        language: t.language,
        name: t.name?.trim() || t.language,
        origin: t.origin,
        origins: [t.origin],
        translatable: t.translatable === true,
        providers: [t.provider],
      });
      continue;
    }
    seen.name = betterName(seen.name, t.name ?? '', t.language);
    seen.translatable ||= t.translatable === true;
    if (!seen.origins.includes(t.origin)) seen.origins.push(t.origin);
    seen.origins.sort((a, b) => ORIGIN_RANK[a] - ORIGIN_RANK[b]);
    seen.origin = seen.origins[0] ?? t.origin;
    if (!seen.providers.includes(t.provider)) seen.providers.push(t.provider);
  }
  return [...byLang.values()].sort(
    (a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || a.name.localeCompare(b.name) || a.language.localeCompare(b.language),
  );
}

/** Languages a translation can target that no listed track already covers, by name. */
export function extraTargets(
  targets: { language: string; name: string }[],
  tracks: CaptionTrack[],
): { language: string; name: string }[] {
  const have = new Set(tracks.map((t) => t.language.toLowerCase()));
  return targets.filter((t) => !have.has(t.language.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
}

export interface CaptionListing extends Omit<CaptionLanguagesResponse, 'tracks'> {
  tracks: CaptionTrack[];
}

/** GET /caption-languages, with the tracks merged. */
export async function getCaptionLanguages(url: string, call: CallOptions = {}): Promise<CaptionListing> {
  const res = await requestJson<CaptionLanguagesResponse>('GET', '/caption-languages', { url }, undefined, call);
  return { ...res, tracks: mergeTracks(res.tracks) };
}

export interface FormatInfo {
  id: string;
  description: string;
  mimeType: string;
  extension: string;
}

/** The formats that make sense for captions alone, in the order offered. Others the server has (pack, markdown) are context formats. */
export const CAPTION_FORMAT_IDS = ['srt', 'vtt', 'text', 'json'] as const;

export const FORMAT_LABELS: Record<string, string> = {
  srt: 'SubRip (.srt)',
  vtt: 'WebVTT (.vtt)',
  text: 'Plain text (.txt)',
  json: 'JSON with timings (.json)',
};

/** GET /formats, keeping the caption formats this server has, in CAPTION_FORMAT_IDS order. */
export async function getCaptionFormats(call: CallOptions = {}): Promise<FormatInfo[]> {
  const { formats } = await requestJson<{ formats: FormatInfo[] }>('GET', '/formats', {}, undefined, call);
  return CAPTION_FORMAT_IDS.map((id) => formats.find((f) => f.id === id)).filter((f): f is FormatInfo => !!f);
}

export interface CaptionRequest {
  url: string;
  language: string;
  format: string;
  /** Translate into `language` when no track is in it: the platform's translation first, then an LLM. */
  translate?: boolean;
  /** For the text format: "[m:ss]" before each line. */
  timestamps?: boolean;
}

/** The GET /transcript link for one track: also usable as a plain download link. */
export function captionUrl(req: CaptionRequest, base = apiBase()): string {
  return apiUrl(
    '/transcript',
    {
      url: req.url,
      lang: req.language,
      format: req.format,
      mode: 'captions',
      translate: req.translate ? '1' : undefined,
      timestamps: req.timestamps ? '1' : undefined,
    },
    base,
  );
}

export interface CaptionFile {
  text: string;
  mimeType: string;
  /** With translate: source, platform or llm (X-Translated-Via). */
  translatedVia?: string;
}

/** GET /transcript as text. API errors keep their code, hint and attempts. */
export async function fetchCaption(req: CaptionRequest, call: CallOptions = {}): Promise<CaptionFile> {
  const base = call.base ?? apiBase();
  const doFetch = call.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(captionUrl(req, base), { signal: call.signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw unreachable(base, err);
  }
  const mimeType = res.headers.get('content-type') ?? 'text/plain';
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    if (isApiErrorBody(body)) throw fromApiBody(body, res.status);
    throw unreachable(base);
  }
  const translatedVia = res.headers.get('x-translated-via') ?? undefined;
  return { text: await res.text(), mimeType, ...(translatedVia ? { translatedVia } : {}) };
}

/** "Me at the zoo.de.auto.srt": the title (safe on every filesystem), the language, auto when it is auto-captions, the extension. */
export function captionFileName(title: string, language: string, extension: string, opts: { auto?: boolean; translated?: boolean } = {}): string {
  const safe =
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 120) || 'captions';
  const tags = [language, opts.auto ? 'auto' : '', opts.translated ? 'translated' : ''].filter(Boolean).join('.');
  return `${safe}.${tags}.${extension}`;
}

/** Every file in one .zip, named as given. */
export function zipCaptions(files: { name: string; text: string }[]): Promise<Blob> {
  const encoder = new TextEncoder();
  return streamToBlob(
    zipStream(files.map((f) => ({ path: f.name, data: encoder.encode(f.text) }))),
    'application/zip',
  );
}
