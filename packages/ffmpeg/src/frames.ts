/**
 * Frame extraction: JPEG frames with timestamps, either every N seconds or on
 * scene changes. Timestamps come from ffmpeg's showinfo filter, so they are the
 * real presentation times of the frames written.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Vid2ContextError } from '@vid2context/core';
import { withTempDir } from './audio.ts';
import { locateFfmpeg, majorVersion } from './locate.ts';
import { type FfCtx, inputGuards, runProcess, toInput } from './process.ts';

export interface ExtractFramesOptions {
  /** One frame every this many seconds. Default 10 when sceneThreshold is not set. */
  everySec?: number;
  /** Scene-change score from 0 to 1 (0.3 is a good start). The first frame is always included. */
  sceneThreshold?: number;
  /** Stop after this many frames. */
  maxFrames: number;
  /** Output width in pixels; height keeps the aspect ratio. Default 640. */
  width?: number;
  /** JPEG quality, 2 (best) to 31. Default 4. */
  quality?: number;
  /** Default 30 minutes. */
  timeoutMs?: number;
}

export interface Frame {
  atSec: number;
  data: Uint8Array;
  mimeType: 'image/jpeg';
}

/** Parse pts_time values from showinfo lines, in order. */
export function parseShowinfoTimes(lines: string[]): number[] {
  const out: number[] = [];
  for (const line of lines) {
    const m = /\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+)/.exec(line);
    if (m?.[1]) out.push(Math.max(0, Number(m[1])));
  }
  return out;
}

export async function extractFrames(input: string, opts: ExtractFramesOptions, ctx: FfCtx = {}): Promise<Frame[]> {
  const target = toInput(input);
  if (!Number.isInteger(opts.maxFrames) || opts.maxFrames < 1) {
    throw new Vid2ContextError('bad-request', 'maxFrames must be a positive integer.', {
      hint: 'Pass maxFrames: 20, for example.',
    });
  }
  if (opts.sceneThreshold !== undefined && (opts.sceneThreshold <= 0 || opts.sceneThreshold >= 1)) {
    throw new Vid2ContextError('bad-request', 'sceneThreshold must be between 0 and 1.', { hint: 'Try 0.3.' });
  }
  const everySec = opts.everySec ?? (opts.sceneThreshold === undefined ? 10 : undefined);
  if (everySec !== undefined && !(everySec > 0)) {
    throw new Vid2ContextError('bad-request', 'everySec must be positive.', { hint: 'Try everySec: 10.' });
  }
  const width = Math.max(16, Math.round(opts.width ?? 640));
  const tools = await locateFfmpeg(ctx, { download: false });

  const select = opts.sceneThreshold !== undefined ? `select='eq(n,0)+gt(scene,${opts.sceneThreshold})'` : `fps=1/${everySec}`;
  const filter = `${select},showinfo,scale=${width}:-2`;
  const major = majorVersion(tools.version);
  const vfr = major !== undefined && major < 5 ? ['-vsync', 'vfr'] : ['-fps_mode', 'vfr'];

  return withTempDir(async (dir) => {
    const lines: string[] = [];
    await runProcess(
      tools.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-loglevel',
        'info',
        ...inputGuards(target),
        '-i',
        target,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-vf',
        filter,
        ...vfr,
        '-frames:v',
        String(opts.maxFrames),
        '-q:v',
        String(opts.quality ?? 4),
        join(dir, 'frame-%06d.jpg'),
      ],
      {
        label: 'ffmpeg frame extraction',
        signal: ctx.signal,
        timeoutMs: opts.timeoutMs ?? 30 * 60_000,
        onStderrLine: (line) => {
          if (line.includes('Parsed_showinfo')) lines.push(line);
        },
      },
    );
    const times = parseShowinfoTimes(lines);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    const count = Math.min(files.length, times.length);
    const frames: Frame[] = [];
    for (let i = 0; i < count; i++) {
      const file = files[i];
      const atSec = times[i];
      if (file === undefined || atSec === undefined) continue;
      frames.push({ atSec, data: new Uint8Array(await readFile(join(dir, file))), mimeType: 'image/jpeg' });
    }
    return frames;
  });
}
