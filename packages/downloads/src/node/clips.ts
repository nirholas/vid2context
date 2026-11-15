/**
 * Frame grabs and animated GIF/WebP clips, Node side.
 *
 * ffmpeg always reads a local file. A web video is first downloaded through
 * the normal downloader (yt-dlp, with its recoveries and stall protection),
 * only the part needed when that is short, because static ffmpeg builds
 * crash on https inputs and seeking over the network is slow.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Ctx, checkInput, type Registry, Vid2ContextError } from '@vid2context/core';
import { type FfmpegTools, hasVideo, locateFfmpeg, probeWith, runProcess } from '@vid2context/ffmpeg';
import { type AnimationRequest, animationArgs, type FramesRequest, frameArgs, IMAGE_MIME_TYPES } from '../clips.ts';
import { toolkitLimits } from '../limits.ts';
import { clock, normalizeRequest, VIDEO_QUALITIES, type VideoQuality } from '../options.ts';
import { downloadPolicy } from '../policy.ts';
import type { DownloadProgress } from '../progress.ts';
import type { TaskOptions, ToolkitFile } from '../toolkit.ts';
import type { Downloader } from '../types.ts';
import { moveInto, outputName, stamp } from './files.ts';
import { type Piece, savePieces } from './pack.ts';
import { Watchdog, waitForExit } from './watchdog.ts';

/** Seconds of video downloaded around frame grabs before the whole video is fetched instead. */
const MAX_SECTION_SPAN = 300;

interface Source {
  path: string;
  title: string;
  id?: string;
  /** Seconds to subtract from requested times (the start of the downloaded part). */
  offset: number;
  source: string;
  durationSec?: number;
}

export interface ClipsDeps {
  registry: Registry;
  downloader: Downloader;
}

/** Run ffmpeg under the watchdog; output on stdout is returned when `capture` is set. */
async function ffmpegTask(
  tools: FfmpegTools,
  args: string[],
  o: { label: string; ctx: Ctx; capture?: boolean; durationSec?: number; onPercent?: (p: number) => void },
): Promise<Uint8Array> {
  const policy = downloadPolicy(o.ctx.env);
  const dog = new Watchdog({
    label: o.label,
    stallMs: toolkitLimits(o.ctx.env).stallSec * 1000,
    deadlineAt: Date.now() + policy.timeoutSec * 1000,
    ...(policy.maxBytes > 0 ? { maxBytes: policy.maxBytes } : {}),
    ...(o.ctx.signal ? { parent: o.ctx.signal } : {}),
  });
  let pid: number | undefined;
  try {
    const res = await runProcess(
      tools.ffmpeg,
      ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-nostats', '-progress', 'pipe:2', ...args],
      {
        label: o.label,
        signal: dog.signal,
        timeoutMs: dog.remainingMs(policy.timeoutSec * 1000) + 5000,
        ...(o.capture ? { captureStdout: true, maxStdoutBytes: 64 * 1024 * 1024 } : {}),
        onSpawn: (p) => {
          pid = p;
        },
        onStderrLine: (line) => {
          dog.touch();
          const size = /^total_size=(\d+)/.exec(line);
          if (size) dog.reportBytes(Number(size[1]));
          const t = /^out_time_us=(\d+)/.exec(line);
          if (t && o.durationSec && o.onPercent)
            o.onPercent(Math.min(99.9, Math.round((Number(t[1]) / 1e6 / o.durationSec) * 1000) / 10));
        },
      },
    );
    return res.stdout;
  } catch (err) {
    await waitForExit(pid);
    throw dog.error() ?? err;
  } finally {
    dog.stop();
  }
}

/** The smallest download quality whose picture still covers `width` (assuming 16:9). */
export function qualityForWidth(width: number): VideoQuality {
  const need = Math.ceil((width * 9) / 16);
  const ladder = VIDEO_QUALITIES.filter((q) => q !== 'best')
    .map(Number)
    .sort((a, b) => a - b);
  const q = ladder.find((h) => h >= Math.max(need, 240)) ?? ladder.at(-1);
  return String(q) as VideoQuality;
}

export function createClipsEngine({ registry, downloader }: ClipsDeps) {
  /** A local file to read, downloading the part [fromSec, toSec] (or everything) of a web video first. */
  async function sourceFor(
    input: string,
    ctx: Ctx,
    work: string,
    part: { fromSec?: number; toSec?: number; quality: VideoQuality },
    report: (p: DownloadProgress) => void,
  ): Promise<Source> {
    const refused = checkInput(input, ctx.env);
    if (refused) throw refused;
    const { ref } = registry.resolve(input);
    if (ref.kind !== 'video') {
      throw new Vid2ContextError('unsupported-input', `"${input.slice(0, 200)}" is a ${ref.kind}, not a single video.`, {
        hint: 'Pass one video URL or file.',
      });
    }
    const local = ref.url?.startsWith('file:') ? fileURLToPath(ref.url) : undefined;
    if (local) {
      return { path: local, title: basename(local).replace(/\.[^.]+$/, ''), offset: 0, source: local };
    }
    const req = normalizeRequest({
      input,
      format: 'mp4',
      quality: part.quality,
      ...(part.fromSec !== undefined ? { from: part.fromSec } : {}),
      ...(part.toSec !== undefined ? { to: part.toSec } : {}),
      // Exact cuts make the part start where asked, so requested times map onto it by one subtraction.
      exactCuts: part.fromSec !== undefined,
      embedThumbnail: false,
      embedMetadata: false,
      embedChapters: false,
    });
    const file = await downloader.download(req, ctx, { dir: work, onProgress: report });
    return {
      path: file.path,
      title: file.title,
      ...(ref.platform !== 'file' ? { id: ref.nativeId } : {}),
      offset: file.section?.fromSec ?? 0,
      source: file.source,
      ...(file.durationSec ? { durationSec: file.durationSec } : {}),
    };
  }

  async function frames(req: FramesRequest, ctx: Ctx, opts: TaskOptions): Promise<ToolkitFile> {
    const report = (p: DownloadProgress) => opts.onProgress?.(p);
    report({ phase: 'preparing', downloadedBytes: 0 });
    const first = req.times[0] as number;
    const last = req.times.at(-1) as number;
    const work = await mkdtemp(join(tmpdir(), 'vid2context-frames-'));
    try {
      const span = last - first;
      const src = await sourceFor(
        req.input,
        ctx,
        work,
        span <= MAX_SECTION_SPAN ? { fromSec: first, toSec: last + 1, quality: req.quality } : { quality: req.quality },
        report,
      );
      const tools = await locateFfmpeg(ctx, { download: true });
      const probe = await probeWith(tools.ffprobe, src.path, ctx);
      if (!hasVideo(probe)) {
        throw new Vid2ContextError('unsupported-input', `${src.source} has no video track.`, {
          hint: 'Frames need a video; for audio, download it as audio instead.',
        });
      }
      const pieces: Piece[] = [];
      const warnings: string[] = [];
      const fullDuration = src.offset === 0 ? probe.durationSec : undefined;
      for (const [i, t] of req.times.entries()) {
        report({
          phase: 'processing',
          step: 'Frames',
          downloadedBytes: 0,
          percent: Math.round((i / req.times.length) * 1000) / 10,
        });
        if (fullDuration !== undefined && t >= fullDuration) {
          warnings.push(`${clock(t)} is past the end of the video (${clock(fullDuration)}); no frame there.`);
          continue;
        }
        const at = Math.max(0, t - src.offset);
        const data = await ffmpegTask(tools, ['-ss', String(at), '-i', src.path, ...frameArgs(req.format, req.width), 'pipe:1'], {
          label: 'ffmpeg frame grab',
          ctx,
          capture: true,
        });
        if (data.length === 0) {
          warnings.push(`No frame at ${clock(t)} (past the end of the video).`);
          continue;
        }
        const ms = Math.round((t % 1) * 1000);
        const label = `${stamp(Math.floor(t))}${ms ? `${String(ms).padStart(3, '0')}ms` : ''}`;
        pieces.push({
          name: outputName({ title: `${src.title} ${label}`, ...(src.id ? { id: src.id } : {}), ext: req.format }),
          data,
          mimeType: IMAGE_MIME_TYPES[req.format],
        });
      }
      if (pieces.length === 0) {
        throw new Vid2ContextError('bad-request', 'Every requested time is past the end of the video.', {
          hint: 'Pick times inside the video (see its duration with get_media_options).',
        });
      }
      const saved = await savePieces(pieces, {
        dir: opts.dir,
        ...(opts.overwrite !== undefined ? { overwrite: opts.overwrite } : {}),
        zipName: outputName({ title: `${src.title} frames`, ...(src.id ? { id: src.id } : {}), ext: 'zip' }),
        forceZip: req.zip,
      });
      report({ phase: 'finished', percent: 100, downloadedBytes: saved.bytes, totalBytes: saved.bytes });
      return { ...saved, kind: 'frames', title: src.title, source: src.source, warnings };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async function animation(req: AnimationRequest, ctx: Ctx, opts: TaskOptions): Promise<ToolkitFile> {
    const report = (p: DownloadProgress) => opts.onProgress?.(p);
    report({ phase: 'preparing', downloadedBytes: 0 });
    const work = await mkdtemp(join(tmpdir(), 'vid2context-clip-'));
    try {
      const src = await sourceFor(
        req.input,
        ctx,
        work,
        { fromSec: req.fromSec, toSec: req.toSec, quality: qualityForWidth(req.width) },
        report,
      );
      const tools = await locateFfmpeg(ctx, { download: true });
      const probe = await probeWith(tools.ffprobe, src.path, ctx);
      if (!hasVideo(probe)) {
        throw new Vid2ContextError('unsupported-input', `${src.source} has no video track.`, {
          hint: 'Animated clips need a video.',
        });
      }
      if (src.offset === 0 && probe.durationSec !== undefined && req.fromSec >= probe.durationSec) {
        throw new Vid2ContextError(
          'bad-request',
          `from (${clock(req.fromSec)}) is past the end of the video (${clock(probe.durationSec)}).`,
          {
            hint: 'Pick a start inside the video.',
          },
        );
      }
      const length = req.toSec - req.fromSec;
      const out = join(work, `clip.${req.format}`);
      const step = req.format === 'gif' ? 'GIF' : 'WebP';
      await ffmpegTask(
        tools,
        ['-ss', String(Math.max(0, req.fromSec - src.offset)), '-t', String(length), '-i', src.path, ...animationArgs(req), out],
        {
          label: `ffmpeg ${step} export`,
          ctx,
          durationSec: length,
          onPercent: (percent) => report({ phase: 'processing', step, downloadedBytes: 0, percent }),
        },
      );
      const name = outputName({
        title: src.title,
        ...(src.id ? { id: src.id } : {}),
        ext: req.format,
        section: { fromSec: req.fromSec, toSec: req.toSec },
      });
      const path = await moveInto(out, opts.dir, name, opts.overwrite);
      const bytes = (await stat(path)).size;
      report({ phase: 'finished', percent: 100, downloadedBytes: bytes, totalBytes: bytes });
      return {
        path,
        filename: basename(path),
        bytes,
        mimeType: IMAGE_MIME_TYPES[req.format],
        kind: 'animation',
        format: req.format,
        title: src.title,
        source: src.source,
        durationSec: length,
        warnings: [],
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  return { frames, animation };
}
