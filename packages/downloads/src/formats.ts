/**
 * Which qualities a video offers and about how large each download will be,
 * from yt-dlp's `-J` info. The stream picks mirror the sort rules in args.ts
 * (stereo first, H.264 for mp4, VP9 + Opus for webm), so the sizes shown
 * match what the download fetches. Sizes are estimates: exact when the site
 * reports file sizes, otherwise bitrate times duration.
 */
import {
  AUDIO_FORMATS,
  type AudioFormat,
  type AudioQuality,
  FORMAT_LABELS,
  VIDEO_CONTAINERS,
  VIDEO_QUALITIES,
  type VideoContainer,
  type VideoQuality,
} from './options.ts';

/** The fields of one entry in yt-dlp's `formats` list that this module reads. */
export interface YtDlpFormat {
  format_id?: string;
  ext?: string;
  vcodec?: string | null;
  acodec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  tbr?: number | null;
  abr?: number | null;
  vbr?: number | null;
  asr?: number | null;
  audio_channels?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  protocol?: string | null;
  format_note?: string | null;
  dynamic_range?: string | null;
  has_drm?: boolean | null;
  /** yt-dlp's own quality rank for the site (YouTube: 3 for 140 and 251, 2.5 for their DRC variants). */
  quality?: number | null;
}

/** The fields of yt-dlp's info JSON this package reads. */
export interface MediaInfo {
  id?: string;
  title?: string;
  fulltitle?: string;
  duration?: number | null;
  uploader?: string | null;
  channel?: string | null;
  thumbnail?: string | null;
  webpage_url?: string;
  extractor_key?: string;
  is_live?: boolean | null;
  live_status?: string | null;
  chapters?: { start_time?: number; end_time?: number; title?: string }[] | null;
  subtitles?: Record<string, { ext?: string; name?: string }[]> | null;
  automatic_captions?: Record<string, { ext?: string; name?: string }[]> | null;
  formats?: YtDlpFormat[] | null;
  _type?: string;
}

export interface VideoChoice {
  quality: VideoQuality;
  /** Picture size label of the stream mp4 would get, e.g. "1080p60". */
  label: string;
  /** Smaller side of the picture in pixels. */
  height: number;
  fps?: number;
  /** HDR when the picked stream is HDR. */
  hdr?: boolean;
  /** Estimated bytes per container. */
  sizes: Partial<Record<VideoContainer, number>>;
  /** Codecs per container, e.g. { mp4: "h264 + aac" }. */
  codecs: Partial<Record<VideoContainer, string>>;
}

export interface AudioChoice {
  format: AudioFormat;
  quality: AudioQuality;
  label: string;
  sizeBytes?: number;
  /** Bitrate of the result in kbps, when known. */
  kbps?: number;
  /** "copy" when the original stream is kept, "re-encode" when it is converted. */
  method: 'copy' | 're-encode' | 'lossless';
}

export interface MediaOptions {
  id?: string;
  title: string;
  channel?: string;
  durationSec?: number;
  thumbnailUrl?: string;
  webpageUrl?: string;
  extractor?: string;
  isLive: boolean;
  chapters: { title: string; startSec: number; endSec?: number }[];
  /** Video qualities from best to smallest; `best` first. Empty when the source has no picture. */
  video: VideoChoice[];
  /** Audio formats and qualities with estimated sizes. */
  audio: AudioChoice[];
  /** Subtitle languages that can be embedded in a video. */
  subtitles: { language: string; name?: string; auto: boolean }[];
  /** Whether SponsorBlock segments can be cut (YouTube only). */
  canRemoveSegments: boolean;
  formats: { video: { id: VideoContainer; label: string }[]; audio: { id: AudioFormat; label: string }[] };
}

/** A picture stream: a named video codec, or no codec details but a picture size. */
function hasVideo(f: YtDlpFormat): boolean {
  if (f.vcodec === 'none') return false;
  if (f.vcodec) return true;
  return (f.height ?? 0) > 0;
}

/** A sound stream with a named codec. Streams with unknown codecs (yt-dlp leaves them null) are skipped. */
function hasAudio(f: YtDlpFormat): boolean {
  return !!f.acodec && f.acodec !== 'none';
}
const usable = (f: YtDlpFormat) => f.protocol !== 'mhtml' && !f.has_drm && !(f.format_id ?? '').startsWith('sb');

/** yt-dlp's `res`: the smaller side of the picture. */
export function resOf(f: YtDlpFormat): number {
  const w = f.width ?? 0;
  const h = f.height ?? 0;
  if (w > 0 && h > 0) return Math.min(w, h);
  return h || w;
}

function codecFamily(codec: string | null | undefined): string {
  const c = (codec ?? '').toLowerCase();
  if (c.startsWith('avc') || c.startsWith('h264')) return 'h264';
  if (c.startsWith('hev') || c.startsWith('hvc') || c.startsWith('h265')) return 'h265';
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'vp9';
  if (c.startsWith('vp8')) return 'vp8';
  if (c.startsWith('av01')) return 'av1';
  if (c.startsWith('mp4a') || c === 'aac') return 'aac';
  if (c.startsWith('opus')) return 'opus';
  if (c.startsWith('vorbis')) return 'vorbis';
  if (c.startsWith('mp3')) return 'mp3';
  if (c.startsWith('ac-3') || c === 'ac3') return 'ac3';
  if (c.startsWith('ec-3') || c === 'eac3') return 'eac3';
  if (c.startsWith('flac')) return 'flac';
  return c.split('.')[0] || 'unknown';
}

/** yt-dlp's default codec order, best first. */
const VCODEC_ORDER = ['av1', 'vp9', 'h265', 'h264', 'vp8'];
const ACODEC_ORDER = ['flac', 'opus', 'vorbis', 'aac', 'mp3', 'eac3', 'ac3'];

function rank(order: string[], family: string): number {
  const i = order.indexOf(family);
  return i < 0 ? order.length : i;
}

/**
 * yt-dlp's `field:value` preference for codecs: the named codec first, then
 * the ones ranked below it, then the ones above it.
 */
function preferRank(order: string[], family: string, preferred: string): number {
  const r = rank(order, family);
  const p = rank(order, preferred);
  return r >= p ? r - p : order.length + (p - r);
}

function bytesOf(f: YtDlpFormat | undefined, durationSec: number | undefined): number | undefined {
  if (!f) return undefined;
  if (f.filesize && f.filesize > 0) return f.filesize;
  if (f.filesize_approx && f.filesize_approx > 0) return f.filesize_approx;
  if (f.tbr && durationSec) return Math.round((f.tbr * 1000 * durationSec) / 8);
  return undefined;
}

/**
 * One yt-dlp sort field as a comparator: negative when `a` is better.
 * A missing value always ranks last, as in yt-dlp.
 */
type Field = (a: YtDlpFormat, b: YtDlpFormat) => number;

function byValue(get: (f: YtDlpFormat) => number | undefined): Field {
  return (a, b) => {
    const va = get(a);
    const vb = get(b);
    if (va === undefined || vb === undefined) return Number(va === undefined) - Number(vb === undefined);
    return vb - va;
  };
}

/** `channels:2`: two channels first, then fewer, then more; streams without sound last. */
const channelsField: Field = byValue((f) => {
  if (!hasAudio(f)) return undefined;
  const ch = f.audio_channels ?? 2;
  return ch <= 2 ? ch : 2 - ch / 100;
});

function codecField(kind: 'v' | 'a', preferred?: string): Field {
  const order = kind === 'v' ? VCODEC_ORDER : ACODEC_ORDER;
  return byValue((f) => {
    if (kind === 'v' ? !hasVideo(f) : !hasAudio(f)) return undefined;
    const family = codecFamily(kind === 'v' ? f.vcodec : f.acodec);
    return -(preferred ? preferRank(order, family, preferred) : rank(order, family));
  });
}

const PROTO_ORDER = ['https', 'http', 'm3u8_native', 'm3u8', 'http_dash_segments'];

/** yt-dlp's default fields after the ones a sort names: quality, fps, size, bitrate, sample rate, protocol. */
const DEFAULT_TAIL: Field[] = [
  byValue((f) => f.quality ?? undefined),
  byValue((f) => (hasVideo(f) ? (f.fps ?? undefined) : undefined)),
  byValue((f) => (f.filesize || f.filesize_approx) ?? undefined),
  byValue((f) => f.tbr ?? undefined),
  byValue((f) => f.asr ?? undefined),
  byValue((f) => {
    const i = PROTO_ORDER.indexOf(f.protocol ?? '');
    return -(i < 0 ? PROTO_ORDER.length : i);
  }),
];

function sortBy(formats: YtDlpFormat[], fields: Field[]): YtDlpFormat[] {
  return [...formats].sort((a, b) => {
    for (const field of fields) {
      const d = field(a, b);
      if (d) return d;
    }
    return 0;
  });
}

/**
 * Best audio-only stream, as `-f ba -S channels:2[,acodec:x]`: stereo first,
 * then the preferred codec, then yt-dlp's quality, then its default codec order.
 */
export function pickAudio(formats: YtDlpFormat[], preferred?: string): YtDlpFormat | undefined {
  const audio = formats.filter((f) => usable(f) && hasAudio(f) && !hasVideo(f));
  const fields = preferred
    ? [channelsField, codecField('a', preferred), ...DEFAULT_TAIL]
    : [channelsField, DEFAULT_TAIL[0] as Field, codecField('a'), ...DEFAULT_TAIL.slice(1)];
  return sortBy(audio, fields)[0];
}

/**
 * The picture stream `-f bv*+ba/b` takes for one container's sort rule,
 * at or below `limit` (smaller side). Field order follows args.ts: mp4 is
 * `res,vcodec:h264,channels:2,acodec:aac`, webm `res,vcodec:vp9,channels:2,acodec:opus`,
 * mkv `res,channels:2`, each followed by yt-dlp's defaults. `channels` ranks
 * streams that already carry stereo sound above silent ones, which is why
 * YouTube's 360p format 18 wins at 360p.
 */
export function pickVideo(formats: YtDlpFormat[], limit: number, container: VideoContainer): YtDlpFormat | undefined {
  const all = formats.filter((f) => usable(f) && hasVideo(f));
  const capped = all.filter((f) => resOf(f) <= limit);
  // `res:N` prefers the largest at or below N, else the smallest above it.
  const pool = capped.length > 0 ? capped : all;
  const res: Field = capped.length > 0 ? (a, b) => resOf(b) - resOf(a) : (a, b) => resOf(a) - resOf(b);
  const [quality, fps, ...rest] = DEFAULT_TAIL as [Field, Field, ...Field[]];
  const fields: Record<VideoContainer, Field[]> = {
    mp4: [res, codecField('v', 'h264'), channelsField, codecField('a', 'aac'), quality, fps, ...rest],
    webm: [res, codecField('v', 'vp9'), channelsField, codecField('a', 'opus'), quality, fps, ...rest],
    mkv: [res, channelsField, quality, fps, codecField('v'), codecField('a'), ...rest],
  };
  return sortBy(pool, fields[container])[0];
}

function heightLabel(f: YtDlpFormat): string {
  const fps = f.fps && f.fps > 30 ? String(Math.round(f.fps)) : '';
  return `${resOf(f)}p${fps}`;
}

const BEST_MP3_KBPS = 245;

function audioChoices(formats: YtDlpFormat[], durationSec: number | undefined): AudioChoice[] {
  const out: AudioChoice[] = [];
  const est = (kbps: number) => (durationSec ? Math.round((kbps * 1000 * durationSec) / 8) : undefined);
  const withSize = (c: Omit<AudioChoice, 'sizeBytes'>, size: number | undefined): AudioChoice =>
    size !== undefined ? { ...c, sizeBytes: size } : c;
  const anyAudio = formats.some((f) => usable(f) && hasAudio(f));
  if (!anyAudio && formats.length > 0) return out;

  out.push(
    withSize(
      { format: 'mp3', quality: 'best', label: 'MP3, best (VBR, about 245 kbps)', kbps: BEST_MP3_KBPS, method: 're-encode' },
      est(BEST_MP3_KBPS),
    ),
  );
  for (const q of ['320', '256', '192', '160', '128', '96', '64'] as const) {
    const kbps = Number(q);
    out.push(withSize({ format: 'mp3', quality: q, label: `MP3, ${q} kbps`, kbps, method: 're-encode' }, est(kbps)));
  }

  const aac = pickAudio(formats, 'aac');
  const aacIsCopy = aac !== undefined && codecFamily(aac.acodec) === 'aac';
  out.push(
    withSize(
      aacIsCopy
        ? {
            format: 'm4a',
            quality: 'best',
            label: `M4A, original AAC${aac?.abr ? `, ${Math.round(aac.abr)} kbps` : ''}`,
            ...(aac?.abr ? { kbps: Math.round(aac.abr) } : {}),
            method: 'copy',
          }
        : { format: 'm4a', quality: 'best', label: 'M4A (AAC, converted)', method: 're-encode' },
      aacIsCopy ? bytesOf(aac, durationSec) : est(160),
    ),
  );
  const opus = pickAudio(formats, 'opus');
  const opusIsCopy = opus !== undefined && codecFamily(opus.acodec) === 'opus';
  out.push(
    withSize(
      opusIsCopy
        ? {
            format: 'opus',
            quality: 'best',
            label: `Opus, original${opus?.abr ? `, ${Math.round(opus.abr)} kbps` : ''}`,
            ...(opus?.abr ? { kbps: Math.round(opus.abr) } : {}),
            method: 'copy',
          }
        : { format: 'opus', quality: 'best', label: 'Opus (converted)', method: 're-encode' },
      opusIsCopy ? bytesOf(opus, durationSec) : est(128),
    ),
  );
  const src = pickAudio(formats);
  const rate = src?.asr ?? 48000;
  const channels = Math.min(src?.audio_channels ?? 2, 2);
  const wavBytes = durationSec ? Math.round(durationSec * rate * channels * 2) : undefined;
  // FLAC of decoded lossy audio is typically a little over half the size of WAV.
  out.push(
    withSize(
      { format: 'flac', quality: 'best', label: 'FLAC (lossless container)', method: 'lossless' },
      wavBytes ? Math.round(wavBytes * 0.55) : undefined,
    ),
  );
  out.push(
    withSize(
      { format: 'wav', quality: 'best', label: `WAV (${Math.round(rate / 100) / 10} kHz, 16-bit)`, method: 'lossless' },
      wavBytes,
    ),
  );
  return out;
}

function videoChoices(formats: YtDlpFormat[], durationSec: number | undefined): VideoChoice[] {
  const video = formats.filter((f) => usable(f) && hasVideo(f));
  if (video.length === 0) return [];
  const maxRes = Math.max(...video.map(resOf));
  const limits: { quality: VideoQuality; limit: number }[] = [{ quality: 'best', limit: Number.POSITIVE_INFINITY }];
  for (const q of VIDEO_QUALITIES) if (q !== 'best' && Number(q) < maxRes) limits.push({ quality: q, limit: Number(q) });

  const audioFor: Record<VideoContainer, YtDlpFormat | undefined> = {
    mp4: pickAudio(formats, 'aac'),
    webm: pickAudio(formats, 'opus'),
    mkv: pickAudio(formats),
  };
  const out: VideoChoice[] = [];
  for (const { quality, limit } of limits) {
    const picks = Object.fromEntries(VIDEO_CONTAINERS.map((c) => [c, pickVideo(formats, limit, c)])) as Record<
      VideoContainer,
      YtDlpFormat | undefined
    >;
    const main = picks.mp4;
    if (!main) continue;
    const sizes: Partial<Record<VideoContainer, number>> = {};
    const codecs: Partial<Record<VideoContainer, string>> = {};
    for (const c of VIDEO_CONTAINERS) {
      const v = picks[c];
      if (!v) continue;
      const a = hasAudio(v) ? undefined : audioFor[c];
      const vb = bytesOf(v, durationSec);
      const ab = a ? bytesOf(a, durationSec) : 0;
      if (vb !== undefined && ab !== undefined) sizes[c] = vb + ab;
      const vc = codecFamily(v.vcodec);
      const ac = hasAudio(v) ? codecFamily(v.acodec) : a ? codecFamily(a.acodec) : undefined;
      codecs[c] = ac ? `${vc} + ${ac}` : vc;
    }
    const choice: VideoChoice = { quality, label: heightLabel(main), height: resOf(main), sizes, codecs };
    if (main.fps) choice.fps = main.fps;
    if (main.dynamic_range && main.dynamic_range !== 'SDR') choice.hdr = true;
    // A limit that lands on the same stream as the one above adds nothing.
    const prev = out.at(-1);
    if (prev && prev.label === choice.label && prev.sizes.mp4 === choice.sizes.mp4) continue;
    out.push(choice);
  }
  return out;
}

/** Everything the download pickers show, from one `-J` info dump. */
export function mediaOptions(info: MediaInfo): MediaOptions {
  const formats = info.formats ?? [];
  const durationSec = typeof info.duration === 'number' && info.duration > 0 ? info.duration : undefined;
  const subtitles: MediaOptions['subtitles'] = [];
  for (const [language, tracks] of Object.entries(info.subtitles ?? {})) {
    if (language === 'live_chat') continue;
    const name = tracks[0]?.name;
    subtitles.push({ language, ...(name ? { name } : {}), auto: false });
  }
  const creator = new Set(subtitles.map((s) => s.language));
  for (const [language, tracks] of Object.entries(info.automatic_captions ?? {})) {
    // YouTube lists every translation target as "xx-orig" plus "xx"; keep the plain codes.
    if (creator.has(language) || language.endsWith('-orig')) continue;
    const name = tracks[0]?.name;
    subtitles.push({ language, ...(name ? { name } : {}), auto: true });
  }
  const chapters = (info.chapters ?? [])
    .filter((c) => typeof c.start_time === 'number')
    .map((c, i) => ({
      title: c.title?.trim() || `Chapter ${i + 1}`,
      startSec: c.start_time as number,
      ...(typeof c.end_time === 'number' ? { endSec: c.end_time } : {}),
    }));
  // Formats without codec details (direct files, some generic pages) still download; they just have no size list.
  const video = formats.length > 0 ? videoChoices(formats, durationSec) : [];
  const options: MediaOptions = {
    title: info.title || info.fulltitle || info.webpage_url || 'video',
    isLive: info.is_live === true || info.live_status === 'is_live',
    chapters,
    video,
    audio: audioChoices(formats, durationSec),
    subtitles,
    canRemoveSegments: info.extractor_key === 'Youtube',
    formats: {
      video: VIDEO_CONTAINERS.map((id) => ({ id, label: FORMAT_LABELS[id] })),
      audio: AUDIO_FORMATS.map((id) => ({ id, label: FORMAT_LABELS[id] })),
    },
  };
  if (info.id) options.id = info.id;
  const channel = info.channel ?? info.uploader;
  if (channel) options.channel = channel;
  if (durationSec) options.durationSec = durationSec;
  if (info.thumbnail) options.thumbnailUrl = info.thumbnail;
  if (info.webpage_url) options.webpageUrl = info.webpage_url;
  if (info.extractor_key) options.extractor = info.extractor_key;
  return options;
}
