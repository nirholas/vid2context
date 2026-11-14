/**
 * ffmpeg work that never touches the network: converting a local file to
 * the requested format, and trimming a finished download when yt-dlp's
 * section download could not be used (some static ffmpeg builds crash when
 * they open an https URL, see docs/guides/local-files.md).
 *
 * Streams are copied whenever the target container can hold them, so a
 * conversion is usually a fast remux; only codecs the container cannot hold,
 * a smaller picture size, an mp3 bitrate or exact cuts force a re-encode.
 */

import type { Ctx } from '@vid2context/core';
import { type FfmpegTools, hasVideo, type ProbeResult, probeWith, runProcess } from '@vid2context/ffmpeg';
import type { DownloadRequest, MediaFormat, VideoContainer } from '../options.ts';

/** Codecs (ffprobe names) each container can hold without re-encoding. */
const VIDEO_COPY: Record<VideoContainer, { video: string[]; audio: string[] }> = {
  mp4: { video: ['h264', 'hevc', 'av1'], audio: ['aac', 'mp3', 'alac', 'ac3', 'eac3'] },
  webm: { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'] },
  mkv: { video: [], audio: [] },
};

function firstStream(p: ProbeResult, type: 'audio' | 'video') {
  return p.streams.find((s) => s.type === type && !s.isAttachedPic);
}

/** Video encoder arguments for a container when the source cannot be copied. */
function videoEncoder(format: VideoContainer): string[] {
  if (format === 'webm')
    return ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
}

function audioEncoder(format: VideoContainer): string[] {
  if (format === 'webm') return ['-c:a', 'libopus', '-b:a', '128k'];
  return ['-c:a', 'aac', '-b:a', '192k'];
}

export interface ConvertPlan {
  /** Output codec arguments (everything between the input and the output path). */
  args: string[];
  /** Whether any stream is re-encoded (slower; reported in warnings for long files). */
  reencodes: boolean;
}

/** The ffmpeg output arguments that turn `source` into the requested format. Pure, for tests. */
export function convertPlan(
  req: Pick<DownloadRequest, 'kind' | 'format' | 'quality' | 'exactCuts' | 'embedMetadata' | 'embedChapters'>,
  source: ProbeResult,
  opts: { trimmed: boolean },
): ConvertPlan {
  const args: string[] = [];
  let reencodes = false;
  const meta = req.embedMetadata ? ['-map_metadata', '0'] : ['-map_metadata', '-1'];
  const chapters = req.embedChapters && !opts.trimmed && req.format !== 'wav' ? ['-map_chapters', '0'] : ['-map_chapters', '-1'];

  if (req.kind === 'video') {
    const format = req.format as VideoContainer;
    const v = firstStream(source, 'video');
    const a = firstStream(source, 'audio');
    args.push('-map', '0:v:0', '-map', '0:a:0?');
    const res = v?.width && v.height ? Math.min(v.width, v.height) : undefined;
    const limit = req.quality === 'best' ? undefined : Number(req.quality);
    const scale = limit !== undefined && res !== undefined && res > limit;
    const exact = opts.trimmed && req.exactCuts;
    const copyVideo = !scale && !exact && (format === 'mkv' || VIDEO_COPY[format].video.includes(v?.codec ?? ''));
    if (copyVideo) args.push('-c:v', 'copy');
    else {
      reencodes = true;
      if (scale && v?.width && v.height) {
        // Scale the smaller side to the limit; -2 keeps the other side even, as encoders need.
        args.push('-vf', v.width >= v.height ? `scale=-2:${limit}` : `scale=${limit}:-2`);
      }
      args.push(...videoEncoder(format));
    }
    if (a) {
      if (format === 'mkv' || VIDEO_COPY[format].audio.includes(a.codec ?? '')) args.push('-c:a', 'copy');
      else {
        reencodes = true;
        args.push(...audioEncoder(format));
      }
    }
    args.push('-dn', '-sn', ...meta, ...chapters);
    if (format === 'mp4') args.push('-movflags', '+faststart');
    return { args, reencodes };
  }

  const a = firstStream(source, 'audio');
  args.push('-vn', '-sn', '-dn', '-map', '0:a:0');
  const codec = a?.codec ?? '';
  const bitrate = req.quality === 'best' ? undefined : `${req.quality}k`;
  switch (req.format as MediaFormat) {
    case 'mp3':
      if (codec === 'mp3' && !bitrate) args.push('-c:a', 'copy');
      else {
        reencodes = true;
        args.push('-c:a', 'libmp3lame', ...(bitrate ? ['-b:a', bitrate] : ['-q:a', '0']));
      }
      break;
    case 'm4a':
      if (codec === 'aac' || codec === 'alac') args.push('-c:a', 'copy');
      else {
        reencodes = true;
        args.push('-c:a', 'aac', '-b:a', bitrate ?? '192k');
      }
      args.push('-movflags', '+faststart');
      break;
    case 'opus':
      if (codec === 'opus') args.push('-c:a', 'copy');
      else {
        reencodes = true;
        args.push('-c:a', 'libopus', '-b:a', bitrate ?? '128k');
      }
      break;
    case 'flac':
      if (codec !== 'flac') reencodes = true;
      args.push('-c:a', 'flac');
      break;
    case 'wav':
      reencodes = true;
      args.push('-c:a', 'pcm_s16le');
      break;
  }
  args.push(...meta, ...chapters);
  return { args, reencodes };
}

/** ffmpeg's muxer name for each format, so the output never depends on the file extension. */
export const MUXER: Record<MediaFormat, string> = {
  mp4: 'mp4',
  webm: 'webm',
  mkv: 'matroska',
  mp3: 'mp3',
  m4a: 'ipod',
  opus: 'ogg',
  flac: 'flac',
  wav: 'wav',
};

export interface RunFfmpegOptions {
  tools: FfmpegTools;
  input: string;
  output: string;
  /** Output arguments from convertPlan or trimArgs. */
  args: string[];
  format: MediaFormat;
  section?: { fromSec?: number; toSec?: number };
  /** Duration of the output, for the percentage. */
  durationSec?: number;
  ctx: Ctx;
  timeoutMs: number;
  onPercent?: (percent: number) => void;
}

/** Run ffmpeg with -progress on stderr and report the percentage done. */
export async function runFfmpeg(o: RunFfmpegOptions): Promise<void> {
  const input: string[] = [];
  if (o.section?.fromSec !== undefined) input.push('-ss', String(o.section.fromSec));
  if (o.section?.toSec !== undefined) input.push('-to', String(o.section.toSec));
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-nostats',
    '-progress',
    'pipe:2',
    ...input,
    '-i',
    o.input,
    ...o.args,
    '-f',
    MUXER[o.format],
    o.output,
  ];
  await runProcess(o.tools.ffmpeg, args, {
    label: `ffmpeg ${o.format} conversion`,
    signal: o.ctx.signal,
    timeoutMs: o.timeoutMs,
    onStderrLine: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && o.durationSec && o.onPercent) {
        o.onPercent(Math.min(99.9, Math.round((Number(m[1]) / 1e6 / o.durationSec) * 1000) / 10));
      }
    },
  });
}

/** Output arguments that cut a finished download without re-encoding (or with, for exact video cuts). */
export function trimArgs(req: Pick<DownloadRequest, 'kind' | 'format' | 'exactCuts'>, source: ProbeResult): string[] {
  if (req.kind === 'video' && req.exactCuts) {
    const format = req.format as VideoContainer;
    const a = firstStream(source, 'audio');
    return [
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      ...videoEncoder(format),
      ...(a ? audioEncoder(format) : []),
      '-dn',
      '-map_metadata',
      '0',
      '-map_chapters',
      '-1',
      ...(format === 'mp4' ? ['-movflags', '+faststart'] : []),
    ];
  }
  // Copy every stream (cover art included), drop data tracks and the chapter list, whose times no longer fit.
  return [
    '-map',
    '0',
    '-dn',
    '-c',
    'copy',
    '-map_metadata',
    '0',
    '-map_chapters',
    '-1',
    ...(req.format === 'mp4' || req.format === 'm4a' ? ['-movflags', '+faststart'] : []),
  ];
}

export async function probeFile(tools: FfmpegTools, path: string, ctx: Ctx): Promise<ProbeResult> {
  return probeWith(tools.ffprobe, path, ctx);
}

export { hasVideo };
