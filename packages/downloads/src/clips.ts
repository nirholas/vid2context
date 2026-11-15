/**
 * Frame grabs (still images at given times) and animated clips (GIF or
 * animated WebP of a short range): requests, validation against the
 * toolkit limits, and the ffmpeg arguments. Runtime-neutral; ffmpeg runs in
 * node/clips.ts.
 */
import { Vid2ContextError } from '@vid2context/core';
import { toolkitLimits } from './limits.ts';
import { parseTime, VIDEO_QUALITIES, type VideoQuality } from './options.ts';

export const FRAME_FORMATS = ['png', 'jpg'] as const;
export type FrameFormat = (typeof FRAME_FORMATS)[number];

export const ANIMATION_FORMATS = ['gif', 'webp'] as const;
export type AnimationFormat = (typeof ANIMATION_FORMATS)[number];

export const IMAGE_MIME_TYPES: Record<FrameFormat | AnimationFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export interface FramesRequest {
  kind: 'frames';
  input: string;
  /** Seconds into the video, sorted, without duplicates. */
  times: number[];
  format: FrameFormat;
  /** Largest output width in pixels (never wider than the source); height keeps the aspect ratio. Leave out for the source size. */
  width?: number;
  /** Picture size downloaded from a website to grab from (smaller side). Default 1080. */
  quality: VideoQuality;
  /** Pack the result in a .zip even for one frame. Several frames are always zipped. */
  zip: boolean;
}

export interface AnimationRequest {
  kind: 'animation';
  input: string;
  format: AnimationFormat;
  fromSec: number;
  toSec: number;
  /** Frames per second. Default 10, capped by VID2CONTEXT_MAX_CLIP_FPS. */
  fps: number;
  /** Largest width in pixels: default 480, capped by VID2CONTEXT_MAX_CLIP_WIDTH, and never wider than the source. */
  width: number;
  /** Repeat forever (true, default) or play once. */
  loop: boolean;
}

export interface RawFramesRequest {
  input?: unknown;
  url?: unknown;
  times?: unknown;
  /** Alias of times for query strings and CLI flags. */
  at?: unknown;
  format?: unknown;
  width?: unknown;
  quality?: unknown;
  zip?: unknown;
}

export interface RawAnimationRequest {
  input?: unknown;
  url?: unknown;
  format?: unknown;
  from?: unknown;
  to?: unknown;
  fps?: unknown;
  width?: unknown;
  loop?: unknown;
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function inputOf(raw: { input?: unknown; url?: unknown }): string {
  const input = typeof raw.input === 'string' ? raw.input.trim() : typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!input) throw bad('Missing the video.', 'Pass url (a video URL, YouTube id or file path).');
  return input;
}

function int(value: unknown, label: string, min: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(typeof value === 'string' ? value.trim().replace(/px$/i, '') : value);
  if (!Number.isInteger(n) || n < min) throw bad(`${label} must be a whole number of at least ${min}.`, `Pass ${label}=480.`);
  return n;
}

function flag(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw bad(`${label} must be true or false.`, `Pass ${label}=1 or ${label}=0.`);
}

export function normalizeFramesRequest(raw: RawFramesRequest, env: Record<string, string | undefined> = {}): FramesRequest {
  const input = inputOf(raw);
  const timesRaw = raw.times ?? raw.at;
  const items = Array.isArray(timesRaw)
    ? timesRaw
    : typeof timesRaw === 'string'
      ? timesRaw.split(',')
      : typeof timesRaw === 'number'
        ? [timesRaw]
        : [];
  const times = [...new Set(items.map((t) => parseTime(typeof t === 'string' ? t.trim() : t, 'time')))]
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b);
  if (times.length === 0) throw bad('Pass at least one time to grab a frame at.', 'Pass times=0:10,1:30 (seconds or m:ss).');
  const max = toolkitLimits(env).maxFrames;
  if (times.length > max)
    throw bad(`${times.length} frames asked; the limit is ${max}.`, 'Ask for fewer, or raise VID2CONTEXT_MAX_FRAMES.');
  const formatRaw = raw.format === undefined || raw.format === '' ? 'png' : String(raw.format).trim().toLowerCase();
  const format = formatRaw === 'jpeg' ? 'jpg' : formatRaw;
  if (!(FRAME_FORMATS as readonly string[]).includes(format)) {
    throw bad(`Unknown frame format "${format.slice(0, 20)}".`, `Use ${FRAME_FORMATS.join(' or ')}.`);
  }
  const width = int(raw.width, 'width', 16);
  const q = raw.quality === undefined || raw.quality === '' ? '1080' : String(raw.quality).trim().toLowerCase().replace(/p$/, '');
  if (!(VIDEO_QUALITIES as readonly string[]).includes(q)) {
    throw bad(`Unknown video quality "${q.slice(0, 10)}".`, `Pick one of ${VIDEO_QUALITIES.join(', ')}.`);
  }
  return {
    kind: 'frames',
    input,
    times,
    format: format as FrameFormat,
    ...(width !== undefined ? { width } : {}),
    quality: q as VideoQuality,
    zip: flag(raw.zip, false, 'zip'),
  };
}

export const DEFAULT_CLIP_FPS = 10;
export const DEFAULT_CLIP_WIDTH = 480;

export function normalizeAnimationRequest(
  raw: RawAnimationRequest,
  env: Record<string, string | undefined> = {},
): AnimationRequest {
  const input = inputOf(raw);
  const limits = toolkitLimits(env);
  const formatRaw = raw.format === undefined || raw.format === '' ? 'gif' : String(raw.format).trim().toLowerCase();
  if (!(ANIMATION_FORMATS as readonly string[]).includes(formatRaw)) {
    throw bad(`Unknown clip format "${formatRaw.slice(0, 20)}".`, `Use ${ANIMATION_FORMATS.join(' or ')}.`);
  }
  const fromSec = parseTime(raw.from, 'from') ?? 0;
  const toRaw = parseTime(raw.to, 'to');
  const toSec = toRaw ?? fromSec + Math.min(5, limits.maxClipSec);
  if (toSec <= fromSec) throw bad(`to (${toSec} s) must be after from (${fromSec} s).`, 'Swap the values or widen the range.');
  if (toSec - fromSec > limits.maxClipSec) {
    throw bad(
      `The clip is ${Math.round((toSec - fromSec) * 10) / 10} s; animated clips are at most ${limits.maxClipSec} s.`,
      'Pick a shorter range, export a video clip instead (download with from and to), or raise VID2CONTEXT_MAX_CLIP_SEC.',
    );
  }
  const fps = int(raw.fps, 'fps', 1) ?? Math.min(DEFAULT_CLIP_FPS, limits.maxClipFps);
  if (fps > limits.maxClipFps)
    throw bad(`fps ${fps} is above the limit of ${limits.maxClipFps}.`, 'Lower fps, or raise VID2CONTEXT_MAX_CLIP_FPS.');
  const width = int(raw.width, 'width', 16) ?? Math.min(DEFAULT_CLIP_WIDTH, limits.maxClipWidth);
  if (width > limits.maxClipWidth) {
    throw bad(
      `width ${width} is above the limit of ${limits.maxClipWidth}.`,
      'Lower width, or raise VID2CONTEXT_MAX_CLIP_WIDTH.',
    );
  }
  return {
    kind: 'animation',
    input,
    format: formatRaw as AnimationFormat,
    fromSec,
    toSec,
    fps,
    width,
    loop: flag(raw.loop, true, 'loop'),
  };
}

/**
 * A scale filter that shrinks to `width` but never enlarges: upscaling adds
 * bytes and no detail (a 3 s GIF of a 160 px clip at 480 px was 3 MB). The
 * quotes keep the comma inside min() from splitting the filter chain.
 */
export function noUpscale(width: number): string {
  return `scale=w='min(${Math.round(width)},iw)':h=-2:flags=lanczos`;
}

/** Output arguments for one still frame (after `-ss <t> -i <file>`). */
export function frameArgs(format: FrameFormat, width?: number): string[] {
  const vf = width ? ['-vf', noUpscale(width)] : [];
  const codec =
    format === 'png'
      ? ['-c:v', 'png', '-f', 'image2pipe']
      : ['-c:v', 'mjpeg', '-q:v', '2', '-pix_fmt', 'yuvj420p', '-f', 'image2pipe'];
  return ['-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1', ...vf, ...codec];
}

/**
 * Output arguments for an animated clip (after `-ss <from> -t <len> -i <file>`).
 * GIF builds its own 256-colour palette from the clip (palettegen, diff mode,
 * so moving parts get the colours) and dithers with it; WebP is lossy
 * animated WebP at quality 75.
 */
export function animationArgs(req: Pick<AnimationRequest, 'format' | 'fps' | 'width' | 'loop'>): string[] {
  const base = `fps=${req.fps},${noUpscale(req.width)}`;
  const loop = ['-loop', req.loop ? '0' : req.format === 'gif' ? '-1' : '1'];
  if (req.format === 'gif') {
    // The filter graph picks the picture stream itself; a -map next to it would add the raw stream as a second output.
    return [
      '-an',
      '-sn',
      '-dn',
      '-filter_complex',
      `[0:v:0]${base},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      ...loop,
      '-f',
      'gif',
    ];
  }
  return [
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    base,
    '-c:v',
    'libwebp_anim',
    '-lossless',
    '0',
    '-q:v',
    '75',
    '-compression_level',
    '4',
    ...loop,
    '-f',
    'webp',
  ];
}
