/**
 * Media probing with ffprobe: duration, container, streams, tags and chapters.
 */
import { Vid2ContextError } from '@vid2context/core';
import { withToolsFor } from './locate.ts';
import { type FfCtx, inputGuards, isUrlInput, runProcess, toInput } from './process.ts';

export interface ProbeStream {
  /** Stream index in the container (what `-map 0:<index>` takes). */
  index: number;
  type: 'audio' | 'video' | 'subtitle' | 'data' | 'attachment' | string;
  codec?: string;
  /** BCP-47 language when tagged ('en'), from the container's ISO 639-2 tag ('eng'). */
  language?: string;
  /** The raw language tag as stored in the container. */
  languageTag?: string;
  title?: string;
  channels?: number;
  sampleRate?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  isDefault?: boolean;
  isForced?: boolean;
  /** Cover art and thumbnails are video streams with this set. */
  isAttachedPic?: boolean;
}

export interface ProbeChapter {
  title: string;
  startSec: number;
  endSec?: number;
}

export interface ProbeResult {
  durationSec?: number;
  /** ffprobe format_name, e.g. 'mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'mp3'. */
  container?: string;
  containerName?: string;
  sizeBytes?: number;
  bitRate?: number;
  /** Format tags with lowercase keys: title, artist, date, comment, album, ... */
  tags: Record<string, string>;
  streams: ProbeStream[];
  chapters: ProbeChapter[];
}

const ISO639_2: Record<string, string> = {
  ara: 'ar',
  ben: 'bn',
  bul: 'bg',
  cat: 'ca',
  ces: 'cs',
  cze: 'cs',
  chi: 'zh',
  zho: 'zh',
  dan: 'da',
  deu: 'de',
  ger: 'de',
  ell: 'el',
  gre: 'el',
  eng: 'en',
  est: 'et',
  fas: 'fa',
  per: 'fa',
  fin: 'fi',
  fra: 'fr',
  fre: 'fr',
  heb: 'he',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  ind: 'id',
  ita: 'it',
  jpn: 'ja',
  kor: 'ko',
  lav: 'lv',
  lit: 'lt',
  msa: 'ms',
  may: 'ms',
  nld: 'nl',
  dut: 'nl',
  nor: 'no',
  nob: 'nb',
  nno: 'nn',
  pol: 'pl',
  por: 'pt',
  ron: 'ro',
  rum: 'ro',
  rus: 'ru',
  slk: 'sk',
  slo: 'sk',
  slv: 'sl',
  spa: 'es',
  srp: 'sr',
  swe: 'sv',
  tam: 'ta',
  tel: 'te',
  tha: 'th',
  tur: 'tr',
  ukr: 'uk',
  urd: 'ur',
  vie: 'vi',
  tgl: 'tl',
  swa: 'sw',
  afr: 'af',
  isl: 'is',
  ice: 'is',
  gle: 'ga',
  cym: 'cy',
  wel: 'cy',
  eus: 'eu',
  baq: 'eu',
  glg: 'gl',
  kat: 'ka',
  geo: 'ka',
  hye: 'hy',
  arm: 'hy',
  mkd: 'mk',
  mac: 'mk',
  sqi: 'sq',
  alb: 'sq',
  bos: 'bs',
  mar: 'mr',
  guj: 'gu',
  kan: 'kn',
  mal: 'ml',
  pan: 'pa',
  nep: 'ne',
  sin: 'si',
  khm: 'km',
  lao: 'lo',
  mya: 'my',
  bur: 'my',
  mon: 'mn',
  kaz: 'kk',
  uzb: 'uz',
  aze: 'az',
  bel: 'be',
  lat: 'la',
  epo: 'eo',
};

/**
 * Normalise a container or file-name language tag to BCP-47: 'eng' -> 'en',
 * 'pt-br' -> 'pt-BR', 'und' and empty -> undefined.
 */
export function toBcp47(tag: string | undefined): string | undefined {
  const t = tag?.trim();
  if (!t) return undefined;
  const lower = t.toLowerCase();
  if (lower === 'und' || lower === 'mis' || lower === 'zxx' || lower === 'mul') return undefined;
  const [primary = '', ...rest] = t.split(/[-_]/);
  const p = primary.toLowerCase();
  const base = p.length === 3 ? (ISO639_2[p] ?? p) : p;
  if (!/^[a-z]{2,3}$/.test(base)) return undefined;
  return [base, ...rest.map((r) => (r.length === 2 ? r.toUpperCase() : r))].join('-');
}

interface RawStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  sample_rate?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}
interface RawChapter {
  start_time?: string;
  end_time?: string;
  tags?: Record<string, string>;
}
export interface RawProbe {
  format?: {
    format_name?: string;
    format_long_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams?: RawStream[];
  chapters?: RawChapter[];
}

function num(v: string | number | undefined): number | undefined {
  if (v === undefined || v === '' || v === 'N/A') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function lowerKeys(tags: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags ?? {})) if (typeof v === 'string') out[k.toLowerCase()] = v;
  return out;
}

/** Turn ffprobe's JSON into a ProbeResult. */
export function parseProbe(raw: RawProbe): ProbeResult {
  const f = raw.format ?? {};
  const streams = (raw.streams ?? []).map((s): ProbeStream => {
    const tags = lowerKeys(s.tags);
    return {
      index: s.index,
      type: s.codec_type ?? 'unknown',
      codec: s.codec_name,
      language: toBcp47(tags.language),
      languageTag: tags.language,
      title: tags.title,
      channels: s.channels,
      sampleRate: num(s.sample_rate),
      width: s.width,
      height: s.height,
      durationSec: num(s.duration),
      isDefault: s.disposition?.default === 1,
      isForced: s.disposition?.forced === 1,
      isAttachedPic: s.disposition?.attached_pic === 1,
    };
  });
  const chapters = (raw.chapters ?? []).flatMap((c, i): ProbeChapter[] => {
    const startSec = num(c.start_time);
    if (startSec === undefined) return [];
    const title = lowerKeys(c.tags).title?.trim() || `Chapter ${i + 1}`;
    return [{ title, startSec, endSec: num(c.end_time) }];
  });
  return {
    durationSec: num(f.duration),
    container: f.format_name,
    containerName: f.format_long_name,
    sizeBytes: num(f.size),
    bitRate: num(f.bit_rate),
    tags: lowerKeys(f.tags),
    streams,
    chapters,
  };
}

/** True when the media has a real video track (not just cover art). */
export function hasVideo(p: ProbeResult): boolean {
  return p.streams.some((s) => s.type === 'video' && !s.isAttachedPic);
}

/** Probe a file path or http(s) URL with ffprobe. Never downloads ffmpeg. */
export async function probe(input: string, ctx: FfCtx = {}, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  return withToolsFor(toInput(input), ctx, { download: false }, (tools) => probeWith(tools.ffprobe, input, ctx, opts));
}

/** Probe with a known ffprobe binary (skips locating). */
export async function probeWith(
  ffprobe: string,
  input: string,
  ctx: FfCtx = {},
  opts: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const target = toInput(input);
  const res = await runProcess(
    ffprobe,
    [
      '-hide_banner',
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      ...inputGuards(target),
      '-i',
      target,
    ],
    {
      network: isUrlInput(target),
      label: 'ffprobe',
      captureStdout: true,
      timeoutMs: opts.timeoutMs ?? 60_000,
      signal: ctx.signal,
    },
  );
  let raw: RawProbe;
  try {
    raw = JSON.parse(new TextDecoder().decode(res.stdout)) as RawProbe;
  } catch (err) {
    throw new Vid2ContextError('upstream', 'ffprobe returned output that is not JSON.', { cause: err });
  }
  return parseProbe(raw);
}
