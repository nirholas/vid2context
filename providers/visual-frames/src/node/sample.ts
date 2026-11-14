/**
 * Frame sampling with ffmpeg (Node only).
 *
 * One ffmpeg pass selects frames where the picture changes, plus a frame at
 * least every `maxIntervalSec` and never two within `minIntervalSec`:
 *
 *   select = first frame
 *          + (t - last selected >= maxIntervalSec)
 *          + (scene score > sceneThreshold) * (t - last selected >= minIntervalSec)
 *
 * Each selected frame is written twice: a JPEG scaled to `width` (what a rung
 * reads) and a THUMB_WIDTH x THUMB_HEIGHT grayscale copy on stdout (what
 * hashing reads), so no JPEG decoder is needed. Times come from showinfo.
 * ffmpeg is spawned without a shell and killed when ctx.signal aborts.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Ctx, Vid2ContextError } from '@vid2context/core';
import { inputGuards, locateFfmpeg, majorVersion, parseShowinfoTimes, runProcess, toInput } from '@vid2context/ffmpeg';
import { dHash, sharpness, THUMB_HEIGHT, THUMB_WIDTH } from '../hash.ts';
import type { SampledFrame } from '../select.ts';

export interface SampleOptions {
  /** Scene-change score from 0 to 1 that counts as a new picture. Default 0.3. */
  sceneThreshold?: number;
  /** Never two frames closer than this. Default 2 s. */
  minIntervalSec?: number;
  /** At least one frame this often, even without a scene change. Default 30 s. */
  maxIntervalSec?: number;
  /** JPEG width in pixels (never upscaled). Default 1024. */
  width?: number;
  /** JPEG quality, 2 (best) to 31. Default 3. */
  quality?: number;
  /** Default 30 minutes. */
  timeoutMs?: number;
}

export const SAMPLE_DEFAULTS = {
  sceneThreshold: 0.3,
  minIntervalSec: 2,
  maxIntervalSec: 30,
  width: 1024,
  quality: 3,
} as const;

export interface SampledFrames {
  frames: SampledFrame[];
  /** JPEG path per frame index. */
  files: string[];
  durationSec?: number;
}

function check(name: string, v: number, ok: boolean, hint: string): void {
  if (!Number.isFinite(v) || !ok) throw new Vid2ContextError('bad-request', `Invalid ${name}: ${v}.`, { hint });
}

export function resolveSampleOptions(o: SampleOptions = {}): Required<Omit<SampleOptions, 'timeoutMs'>> & { timeoutMs: number } {
  const r = {
    sceneThreshold: o.sceneThreshold ?? SAMPLE_DEFAULTS.sceneThreshold,
    minIntervalSec: o.minIntervalSec ?? SAMPLE_DEFAULTS.minIntervalSec,
    maxIntervalSec: o.maxIntervalSec ?? SAMPLE_DEFAULTS.maxIntervalSec,
    width: Math.round(o.width ?? SAMPLE_DEFAULTS.width),
    quality: Math.round(o.quality ?? SAMPLE_DEFAULTS.quality),
    timeoutMs: o.timeoutMs ?? 30 * 60_000,
  };
  check('sceneThreshold', r.sceneThreshold, r.sceneThreshold > 0 && r.sceneThreshold < 1, 'Use a value between 0 and 1; 0.3 is the default, 0.1 catches soft transitions.');
  check('minIntervalSec', r.minIntervalSec, r.minIntervalSec >= 0, 'Use 0 or more seconds; the default is 2.');
  check('maxIntervalSec', r.maxIntervalSec, r.maxIntervalSec > 0 && r.maxIntervalSec >= r.minIntervalSec, 'Use more seconds than minIntervalSec; the default is 30.');
  check('width', r.width, r.width >= 64 && r.width <= 4096, 'Use a width between 64 and 4096 pixels; the default is 1024.');
  check('quality', r.quality, r.quality >= 2 && r.quality <= 31, 'Use a JPEG quality between 2 (best) and 31.');
  return r;
}

/** The ffmpeg select expression (commas are safe inside the quoted filter option). */
export function selectExpression(o: { sceneThreshold: number; minIntervalSec: number; maxIntervalSec: number }): string {
  return `gt(isnan(prev_selected_t)+gte(t-prev_selected_t,${o.maxIntervalSec})+gt(scene,${o.sceneThreshold})*gte(t-prev_selected_t,${o.minIntervalSec}),0)`;
}

export function samplingArgs(
  input: string,
  outDir: string,
  o: { sceneThreshold: number; minIntervalSec: number; maxIntervalSec: number; width: number; quality: number },
  ffmpegMajor?: number,
): string[] {
  const vfr = ffmpegMajor !== undefined && ffmpegMajor < 5 ? ['-vsync', 'vfr'] : ['-fps_mode', 'vfr'];
  const graph =
    `[0:v:0]select='${selectExpression(o)}',showinfo,split=2[a][b];` +
    `[a]scale='min(${o.width},iw)':-2[full];` +
    `[b]scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:flags=area,format=gray[small]`;
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-loglevel',
    'info',
    ...inputGuards(input),
    '-i',
    input,
    '-an',
    '-sn',
    '-dn',
    '-filter_complex',
    graph,
    '-map',
    '[full]',
    ...vfr,
    '-q:v',
    String(o.quality),
    join(outDir, 'f%06d.jpg'),
    '-map',
    '[small]',
    ...vfr,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ];
}

/** "Duration: 00:02:00.00" from ffmpeg's input banner, in seconds. */
export function parseDuration(lines: string[]): number | undefined {
  for (const line of lines) {
    const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return undefined;
}

/** Split raw gray thumbnails from stdout and hash each one. */
export function framesFromThumbs(raw: Uint8Array, times: number[]): SampledFrame[] {
  const size = THUMB_WIDTH * THUMB_HEIGHT;
  const count = Math.min(Math.floor(raw.length / size), times.length);
  const out: SampledFrame[] = [];
  for (let i = 0; i < count; i++) {
    const img = { width: THUMB_WIDTH, height: THUMB_HEIGHT, data: raw.subarray(i * size, (i + 1) * size) };
    out.push({ index: i, atSec: times[i] ?? 0, hash: dHash(img), sharpness: sharpness(img) });
  }
  return out;
}

export async function sampleFrames(input: string, outDir: string, opts: SampleOptions, ctx: Ctx): Promise<SampledFrames> {
  const o = resolveSampleOptions(opts);
  const target = toInput(input);
  const tools = await locateFfmpeg(ctx, { download: false });
  const showinfo: string[] = [];
  const banner: string[] = [];
  const { stdout } = await runProcess(tools.ffmpeg, samplingArgs(target, outDir, o, majorVersion(tools.version)), {
    label: 'ffmpeg frame sampling',
    signal: ctx.signal,
    timeoutMs: o.timeoutMs,
    captureStdout: true,
    maxStdoutBytes: 512 * 1024 * 1024,
    onStderrLine: (line) => {
      if (line.includes('showinfo')) showinfo.push(line);
      else if (banner.length < 200) banner.push(line);
    },
  });
  const times = parseShowinfoTimes(showinfo);
  const jpgs = (await readdir(outDir)).filter((f) => /^f\d{6}\.jpg$/.test(f)).sort();
  const frames = framesFromThumbs(stdout, times).filter((f) => f.index < jpgs.length);
  ctx.log.debug('ffmpeg sampled frames', { frames: frames.length, jpgs: jpgs.length, times: times.length });
  return { frames, files: jpgs.map((f) => join(outDir, f)), durationSec: parseDuration(banner) };
}
