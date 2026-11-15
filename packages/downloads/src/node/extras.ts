/**
 * The Node side of the download extras (see ../extras.ts): burning subtitles
 * into the picture, writing one file per chapter, and saving a thumbnail.
 * Every step runs ffmpeg through @vid2context/ffmpeg, so it shares its
 * timeouts, abort handling and FFMPEG_CONCURRENCY limit.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import {
  type Ctx,
  fetchWithTimeout,
  getVideoContext,
  type Registry,
  render,
  safeFilename,
  Vid2ContextError,
} from '@vid2context/core';
import { extractSubtitles, type FfmpegTools, type ProbeResult, runProcess, textSubtitleStreams } from '@vid2context/ffmpeg';
import { errorFromStderr, run } from '@vid2context/provider-ytdlp';
import {
  type ChapterPart,
  chapterParts,
  partName,
  pickThumbnail,
  shiftSubtitles,
  sniffImage,
  THUMBNAIL_MIME_TYPES,
  type ThumbnailCandidate,
  type ThumbnailFormat,
} from '../extras.ts';
import type { DownloadRequest, MediaFormat, VideoContainer } from '../options.ts';
import type { DownloadProgress } from '../progress.ts';
import type { DownloadedPart, SavedThumbnail } from '../types.ts';
import { freeName, moveInto, outputName } from './files.ts';
import { probeFile, runFfmpeg, trimArgs } from './local.ts';

/** Largest thumbnail image accepted from a site. */
const MAX_THUMBNAIL_BYTES = 20 * 1024 * 1024;

/**
 * A path as a value of the subtitles filter. The filter graph and the
 * filter's own options are parsed in two rounds: quotes protect the path from
 * the graph parser, and backslashes protect `:` and `\` (Windows drive
 * letters) from the option parser. Paths with a single quote cannot be
 * written this way, so callers keep subtitle files in a directory they made.
 */
export function subtitlesFilter(path: string): string {
  const p = path.replace(/\\/g, '/');
  if (p.includes("'")) {
    throw new Vid2ContextError('bad-request', 'The subtitle file path contains a quote.', {
      hint: 'Set TMPDIR to a directory without quotes in its name.',
    });
  }
  return `subtitles=filename='${p.replace(/:/g, '\\:')}'`;
}

/** Encoder arguments for burning: the picture is re-encoded, the sound and subtitle tracks are copied. */
export function burnArgs(subtitlePath: string, format: VideoContainer): string[] {
  const video =
    format === 'webm'
      ? ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
  return [
    // `V` skips cover art, which is a video stream too; burning onto it would fail.
    '-map',
    '0:V:0',
    '-map',
    '0:a?',
    '-map',
    '0:s?',
    '-vf',
    subtitlesFilter(subtitlePath),
    ...video,
    '-c:a',
    'copy',
    '-c:s',
    'copy',
    '-map_metadata',
    '0',
    '-map_chapters',
    '0',
    ...(format === 'mp4' ? ['-movflags', '+faststart'] : []),
  ];
}

/** yt-dlp arguments that fetch only one language's subtitles as SRT, from a saved `-J` dump. */
export function subtitleFetchArgs(common: string[], infoJson: string, lang: string, outTemplate: string): string[] {
  return [
    ...common,
    '--skip-download',
    '--no-warnings',
    '--write-subs',
    '--write-auto-subs',
    // `-orig` is YouTube's name for the untranslated automatic track.
    '--sub-langs',
    `${lang},${lang}-orig`,
    '--sub-format',
    'srt/vtt/best',
    '--convert-subs',
    'srt',
    '-o',
    outTemplate,
    '--load-info-json',
    infoJson,
  ];
}

/** The subtitle file yt-dlp wrote for `lang`: the exact language first, then `-orig`, then any. */
export async function pickSubtitleFile(dir: string, lang: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /\.(srt|vtt)$/i.test(n));
  } catch {
    return undefined;
  }
  const l = lang.toLowerCase();
  const rank = (n: string) => {
    const lower = n.toLowerCase();
    if (lower.endsWith(`.${l}.srt`) || lower.endsWith(`.${l}.vtt`)) return 0;
    if (lower.includes(`.${l}-orig.`)) return 1;
    if (lower.includes(`.${l}`)) return 2;
    return 3;
  };
  const pick = names.sort((a, b) => rank(a) - rank(b))[0];
  return pick ? join(dir, pick) : undefined;
}

/**
 * Subtitles for a local file: a sidecar next to it ("movie.en.srt", then
 * "movie.srt", or .vtt), else a text subtitle stream in the file tagged with
 * the language, else the only text stream. Returns the text, or undefined.
 */
export async function localSubtitleText(
  path: string,
  lang: string,
  source: ProbeResult,
  ctx: Ctx,
): Promise<{ text: string; from: string } | undefined> {
  const dir = dirname(path);
  const stem = basename(path, extname(path));
  const l = lang.toLowerCase();
  for (const name of [`${stem}.${l}.srt`, `${stem}.${l}.vtt`, `${stem}.srt`, `${stem}.vtt`]) {
    try {
      return { text: await readFile(join(dir, name), 'utf8'), from: name };
    } catch {
      // Not there; try the next name.
    }
  }
  const streams = textSubtitleStreams(source.streams);
  const tagged = streams.find((s) => s.language?.toLowerCase() === l || s.language?.toLowerCase().startsWith(`${l}-`));
  const stream = tagged ?? (streams.length === 1 ? streams[0] : undefined);
  if (!stream) return undefined;
  const text = await extractSubtitles(path, stream.index, ctx);
  return { text, from: `subtitle stream ${stream.index}${stream.language ? ` (${stream.language})` : ''}` };
}

export interface BurnOptions {
  tools: FfmpegTools;
  input: string;
  /** SRT or WebVTT text in the timeline of the original video. */
  subtitles: string;
  format: VideoContainer;
  /** The part of the original kept in `input`, so cue times are moved to match. */
  section?: { fromSec: number; toSec?: number };
  durationSec?: number;
  ctx: Ctx;
  timeoutMs: number;
  report?: (p: DownloadProgress) => void;
}

/** Burn subtitles into a video. Returns the new file's path (next to `input`), or undefined when no cue falls inside the video. */
export async function burnSubtitles(o: BurnOptions): Promise<string | undefined> {
  const srt = shiftSubtitles(o.subtitles, o.section?.fromSec ?? 0, o.section?.toSec);
  if (!srt) return undefined;
  const work = await mkdtemp(join(tmpdir(), 'vid2context-burn-'));
  try {
    const subsPath = join(work, 'subs.srt');
    await writeFile(subsPath, srt);
    const output = join(dirname(o.input), `burned.${o.format}`);
    o.report?.({ phase: 'processing', step: 'Burn subtitles', downloadedBytes: 0, percent: 0 });
    await runFfmpeg({
      tools: o.tools,
      input: o.input,
      output,
      args: burnArgs(subsPath, o.format),
      format: o.format,
      ctx: o.ctx,
      timeoutMs: o.timeoutMs,
      ...(o.durationSec ? { durationSec: o.durationSec } : {}),
      onPercent: (percent) => o.report?.({ phase: 'processing', step: 'Burn subtitles', downloadedBytes: 0, percent }),
    });
    return output;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface SplitOptions {
  tools: FfmpegTools;
  /** The finished download, already in its directory. */
  file: string;
  /** The download directory; part filenames are reported relative to it. */
  dir: string;
  parts: ChapterPart[];
  req: Pick<DownloadRequest, 'kind' | 'format' | 'exactCuts'>;
  ctx: Ctx;
  timeoutMs: number;
  overwrite?: boolean;
  report?: (p: DownloadProgress) => void;
}

/** Write one file per chapter into a folder named after the download. */
export async function splitByChapters(o: SplitOptions & { source?: ProbeResult }): Promise<DownloadedPart[]> {
  if (o.parts.length === 0) return [];
  const ext = extname(o.file).slice(1);
  const stem = basename(o.file, extname(o.file));
  const folder = o.overwrite ? stem : await freeName(o.dir, stem);
  const outDir = join(o.dir, folder);
  await mkdir(outDir, { recursive: true });
  const source = o.source ?? (await probeFile(o.tools, o.file, o.ctx));
  const args = trimArgs(o.req, source);
  const out: DownloadedPart[] = [];
  for (const part of o.parts) {
    o.ctx.signal?.throwIfAborted();
    const name = partName(part, o.parts.length, ext, safeFilename);
    const path = join(outDir, name);
    o.report?.({
      phase: 'processing',
      step: `Chapter ${part.index + 1} of ${o.parts.length}`,
      downloadedBytes: 0,
      percent: Math.round((part.index / o.parts.length) * 1000) / 10,
    });
    await runFfmpeg({
      tools: o.tools,
      input: o.file,
      output: path,
      args,
      format: o.req.format as MediaFormat,
      section: { fromSec: part.fromSec, toSec: part.toSec },
      durationSec: part.toSec - part.fromSec,
      ctx: o.ctx,
      timeoutMs: o.timeoutMs,
    });
    out.push({
      path,
      filename: `${folder}/${name}`,
      bytes: (await stat(path)).size,
      index: part.index,
      title: part.title,
      fromSec: part.fromSec,
      toSec: part.toSec,
    });
  }
  return out;
}

/**
 * The chapter split as the engine runs it: chapters from the finished file
 * (right even after SponsorBlock cuts, since yt-dlp writes adjusted ones),
 * else the site's list. No chapters is a warning, not a failure: the full
 * download is still there.
 */
export async function splitOrWarn(
  o: Omit<SplitOptions, 'parts'> & {
    fallbackChapters: { start_time?: number; end_time?: number; title?: string }[] | null | undefined;
    durationSec?: number;
    warnings: string[];
  },
): Promise<DownloadedPart[] | undefined> {
  const source = await probeFile(o.tools, o.file, o.ctx);
  const own = source.chapters.map((c) => ({
    title: c.title,
    start_time: c.startSec,
    ...(c.endSec !== undefined ? { end_time: c.endSec } : {}),
  }));
  const parts = chapterParts(own.length > 0 ? own : o.fallbackChapters, source.durationSec ?? o.durationSec);
  if (parts.length === 0) {
    o.warnings.push('This video has no chapters, so it was not split; the full file is saved.');
    return undefined;
  }
  if (own.length === 0 && o.req.kind === 'video') {
    // Without chapters in the file, cut times come from the site; SponsorBlock cuts would shift them.
    o.warnings.push('Chapter times came from the site, not the file; parts may be off if segments were cut out.');
  }
  return splitByChapters({ ...o, parts, source });
}

/** yt-dlp fetches one language's subtitles for a saved `-J` dump; returns the text, or undefined when there is no such track. */
export async function siteSubtitleText(o: {
  bin: string;
  common: string[];
  infoJson: string;
  lang: string;
  work: string;
  ctx: Ctx;
}): Promise<string | undefined> {
  const dir = join(o.work, 'burn-subs');
  const res = await run(o.bin, subtitleFetchArgs(o.common, o.infoJson, o.lang, join(dir, 'subs.%(ext)s')), o.ctx, {
    label: 'yt-dlp subtitles',
    timeoutMs: 120_000,
    discardStdout: true,
    maxStderr: 64 * 1024,
  });
  if (res.code !== 0) throw errorFromStderr(res.stderr, 'yt-dlp subtitles', res.code);
  const file = await pickSubtitleFile(dir, o.lang);
  return file ? readFile(file, 'utf8') : undefined;
}

/**
 * Subtitles from vid2context's own pipeline, for when yt-dlp's subtitle
 * request fails (YouTube often answers it with 429) or the video has none:
 * creator captions, then auto-captions through several clients, then
 * speech-to-text. Returns SRT, plus a note when the language differs.
 */
export async function pipelineSubtitleText(o: {
  registry: Registry;
  url: string;
  lang: string;
  ctx: Ctx;
}): Promise<{ text: string; note?: string } | undefined> {
  const context = await getVideoContext(o.registry, o.url, { language: o.lang }, o.ctx);
  const t = context.transcript;
  if (!t || t.segments.length === 0) return undefined;
  const text = render(context, 'srt');
  const got = t.language?.toLowerCase();
  const want = o.lang.toLowerCase();
  const note =
    got && got !== want && !got.startsWith(`${want}-`)
      ? `No ${o.lang} subtitles exist, so the ${t.language} transcript (${t.producer}) was burned in.`
      : undefined;
  return { text, ...(note ? { note } : {}) };
}

/**
 * Burn `subs` into `file` and return the path to keep: the burned file, or
 * `file` itself with a warning when there were no subtitles to burn. A failed
 * subtitle fetch is a warning (like embedded subtitles); a failed burn is an
 * error, since the caller asked for it and ffmpeg is at fault.
 */
export async function applyBurn(o: {
  subs: { text: string } | undefined;
  lang: string;
  file: string;
  format: VideoContainer;
  tools: FfmpegTools;
  section?: { fromSec: number; toSec?: number };
  durationSec?: number;
  ctx: Ctx;
  timeoutMs: number;
  report?: (p: DownloadProgress) => void;
  warnings: string[];
}): Promise<string> {
  if (!o.subs) {
    o.warnings.push(`No ${o.lang} subtitles were found, so none were burned in.`);
    return o.file;
  }
  const burned = await burnSubtitles({
    tools: o.tools,
    input: o.file,
    subtitles: o.subs.text,
    format: o.format,
    ...(o.section ? { section: o.section } : {}),
    ...(o.durationSec ? { durationSec: o.durationSec } : {}),
    ctx: o.ctx,
    timeoutMs: o.timeoutMs,
    ...(o.report ? { report: o.report } : {}),
  });
  if (!burned) {
    o.warnings.push(`The ${o.lang} subtitles have no lines inside the downloaded part, so none were burned in.`);
    return o.file;
  }
  return burned;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) throw tooBig(declared, max);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooBig(total, max);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all;
}

function tooBig(bytes: number, max: number): Vid2ContextError {
  return new Vid2ContextError(
    'too-large',
    `The thumbnail is ${Math.round(bytes / 1048576)} MB; the limit is ${max / 1048576} MB.`,
    {
      hint: 'This is not a normal thumbnail; download the video instead.',
    },
  );
}

/** ffmpeg output arguments for one still image. */
function imageArgs(format: ThumbnailFormat): string[] {
  const codec =
    format === 'jpg'
      ? ['-c:v', 'mjpeg', '-q:v', '2']
      : format === 'png'
        ? ['-c:v', 'png']
        : ['-c:v', 'libwebp', '-quality', '90'];
  return ['-frames:v', '1', ...codec, '-f', 'image2', '-update', '1'];
}

async function ffmpegImage(
  tools: FfmpegTools,
  inputArgs: string[],
  output: string,
  format: ThumbnailFormat,
  ctx: Ctx,
): Promise<void> {
  await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...inputArgs, ...imageArgs(format), output], {
    label: 'ffmpeg thumbnail',
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    timeoutMs: 60_000,
    env: ctx.env,
  });
}

export interface SiteThumbnailOptions {
  info: {
    id?: string;
    title?: string;
    fulltitle?: string;
    thumbnail?: string | null;
    thumbnails?: ThumbnailCandidate[] | null;
    webpage_url?: string;
  };
  pageUrl: string;
  format: ThumbnailFormat;
  dir: string;
  overwrite?: boolean;
  /** Needed only when the image must be converted to another format. */
  tools: () => Promise<FfmpegTools>;
  ctx: Ctx;
}

/** Save the largest thumbnail a site lists, converted to the asked format when needed. */
export async function saveSiteThumbnail(o: SiteThumbnailOptions): Promise<SavedThumbnail> {
  const pick = pickThumbnail(o.info.thumbnails, o.info.thumbnail);
  if (!pick) {
    throw new Vid2ContextError('not-found', 'This video has no thumbnail.', {
      hint: 'Download the video and take a frame from it with a local file path instead.',
    });
  }
  const res = await fetchWithTimeout(o.ctx, pick.url, {}, 30_000);
  if (!res.ok) {
    throw new Vid2ContextError('upstream', `The thumbnail answered HTTP ${res.status}.`, { hint: 'Retry in a moment.' });
  }
  const bytes = await readCapped(res, MAX_THUMBNAIL_BYTES);
  const got = sniffImage(bytes);
  const work = await mkdtemp(join(tmpdir(), 'vid2context-thumb-'));
  try {
    let file = join(work, `thumb.${got ?? 'img'}`);
    await writeFile(file, bytes);
    if (got !== o.format) {
      const out = join(work, `out.${o.format}`);
      await ffmpegImage(await o.tools(), ['-i', file], out, o.format, o.ctx);
      file = out;
    }
    const title = o.info.title || o.info.fulltitle || 'video';
    const name = outputName({ title, ...(o.info.id ? { id: o.info.id } : {}), ext: o.format });
    const path = await moveInto(file, o.dir, name, o.overwrite);
    return {
      path,
      filename: basename(path),
      bytes: (await stat(path)).size,
      mimeType: THUMBNAIL_MIME_TYPES[o.format],
      format: o.format,
      ...(pick.width ? { width: pick.width } : {}),
      ...(pick.height ? { height: pick.height } : {}),
      origin: 'site',
      title,
      source: o.info.webpage_url ?? o.pageUrl,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** A still for a local file: its cover art when it has one, else a frame a tenth of the way in (at most 30 s). */
export async function saveFileThumbnail(o: {
  path: string;
  source: ProbeResult;
  tools: FfmpegTools;
  format: ThumbnailFormat;
  dir: string;
  overwrite?: boolean;
  ctx: Ctx;
}): Promise<SavedThumbnail> {
  const cover = o.source.streams.find((s) => s.type === 'video' && s.isAttachedPic);
  const video = o.source.streams.find((s) => s.type === 'video' && !s.isAttachedPic);
  if (!cover && !video) {
    throw new Vid2ContextError('unsupported-input', `${o.path} has no picture or cover art.`, {
      hint: 'Pick a video file, or an audio file with embedded cover art.',
    });
  }
  const atSec = Math.min(30, (o.source.durationSec ?? 0) / 10);
  const work = await mkdtemp(join(tmpdir(), 'vid2context-thumb-'));
  try {
    const out = join(work, `thumb.${o.format}`);
    const inputArgs = cover
      ? ['-i', o.path, '-map', `0:${cover.index}`]
      : ['-ss', String(Math.round(atSec * 1000) / 1000), '-i', o.path, '-map', `0:${(video as { index: number }).index}`];
    await ffmpegImage(o.tools, inputArgs, out, o.format, o.ctx);
    const base = basename(o.path, extname(o.path));
    const title = o.source.tags.title?.trim() || base;
    const path = await moveInto(out, o.dir, outputName({ title: base, ext: o.format }), o.overwrite);
    const pic = cover ?? video;
    return {
      path,
      filename: basename(path),
      bytes: (await stat(path)).size,
      mimeType: THUMBNAIL_MIME_TYPES[o.format],
      format: o.format,
      ...(pic?.width ? { width: pic.width } : {}),
      ...(pic?.height ? { height: pic.height } : {}),
      origin: cover ? 'cover' : 'frame',
      title,
      source: o.path,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
