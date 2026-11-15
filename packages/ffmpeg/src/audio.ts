/**
 * Audio extraction and normalisation: any input ffmpeg can read (a video, an
 * audio file, an HLS or DASH URL) becomes compact mono audio for
 * speech-to-text.
 *
 * Defaults: mp3 at 16 kHz mono 32 kbps, about 14 MB per hour, which keeps
 * roughly 1.7 hours under Groq's and OpenAI's 25 MB upload limit. Use flac for
 * local speech-to-text, where size does not matter and lossless helps.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { type AudioBytes, Vid2ContextError } from '@vid2context/core';
import { type FfmpegTools, withToolsFor } from './locate.ts';
import { probeWith } from './probe.ts';
import { type FfCtx, inputGuards, isUrlInput, runProcess, toInput } from './process.ts';

export type AudioFormat = 'mp3' | 'flac' | 'wav';

export interface ExtractAudioOptions {
  /** Default 'mp3'. */
  format?: AudioFormat;
  /** Default 16000. */
  sampleRate?: number;
  /** Default 1 (mono). */
  channels?: number;
  /** mp3 bitrate in kbps. Default 32. Ignored for flac and wav. */
  bitrate?: number;
  /** Start offset in seconds. */
  startSec?: number;
  /** Length in seconds from startSec. */
  durationSec?: number;
  /** Refuse output larger than this many bytes. */
  maxBytes?: number;
  /** Base name for the returned filename (without extension). Default: the input's base name. */
  name?: string;
  /** Allow downloading a managed ffmpeg when none is installed. Default true. */
  download?: boolean;
  /** Default 60 minutes. */
  timeoutMs?: number;
}

export type ExtractedAudio = AudioBytes & { durationSec: number };

export const AUDIO_MIME: Record<AudioFormat, string> = { mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav' };

const CODEC_ARGS: Record<AudioFormat, (bitrate: number) => string[]> = {
  mp3: (b) => ['-c:a', 'libmp3lame', '-b:a', `${b}k`],
  flac: () => ['-c:a', 'flac'],
  wav: () => ['-c:a', 'pcm_s16le'],
};

/** Create a private temp directory and always remove it afterwards. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'vid2context-ff-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseName(input: string): string {
  let name = input;
  if (isUrlInput(input)) {
    try {
      name = decodeURIComponent(new URL(input).pathname.split('/').pop() ?? '');
    } catch {
      name = '';
    }
  } else {
    name = basename(input);
  }
  const stem = name.slice(0, name.length - extname(name).length).replace(/[^\p{L}\p{N}._ -]+/gu, '_');
  return stem || 'audio';
}

/** Extract the first audio track of a file or URL as mono speech audio. */
export async function extractAudio(input: string, opts: ExtractAudioOptions = {}, ctx: FfCtx = {}): Promise<ExtractedAudio> {
  const target = toInput(input);
  const format = opts.format ?? 'mp3';
  const sampleRate = opts.sampleRate ?? 16_000;
  const channels = opts.channels ?? 1;
  const bitrate = opts.bitrate ?? 32;
  return withToolsFor(target, ctx, { download: opts.download ?? true }, (tools) =>
    extractWith(tools, target, { format, sampleRate, channels, bitrate }, opts, ctx),
  );
}

async function extractWith(
  tools: FfmpegTools,
  target: string,
  enc: { format: AudioFormat; sampleRate: number; channels: number; bitrate: number },
  opts: ExtractAudioOptions,
  ctx: FfCtx,
): Promise<ExtractedAudio> {
  const { format, sampleRate, channels, bitrate } = enc;
  return withTempDir(async (dir) => {
    const out = join(dir, `audio.${format}`);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...inputGuards(target)];
    if (opts.startSec !== undefined && opts.startSec > 0) args.push('-ss', String(opts.startSec));
    args.push('-i', target);
    if (opts.durationSec !== undefined) args.push('-t', String(opts.durationSec));
    args.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1');
    args.push('-ac', String(channels), '-ar', String(sampleRate), ...CODEC_ARGS[format](bitrate), out);
    try {
      await runProcess(tools.ffmpeg, args, {
        network: isUrlInput(target),
        label: 'ffmpeg audio extraction',
        timeoutMs: opts.timeoutMs ?? 60 * 60_000,
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof Vid2ContextError && /matches no streams/.test(err.message)) {
        throw new Vid2ContextError('unavailable', 'The media has no audio track.', {
          hint: 'Pick a file with sound; for silent screen recordings use visual notes instead of speech-to-text.',
          cause: err,
        });
      }
      throw err;
    }
    const data = new Uint8Array(await readFile(out));
    if (opts.maxBytes !== undefined && data.byteLength > opts.maxBytes) {
      throw new Vid2ContextError(
        'too-large',
        `Extracted audio is ${data.byteLength} bytes, over the ${opts.maxBytes}-byte limit.`,
        {
          hint: 'Use a shorter input, a lower bitrate, or split the audio first.',
        },
      );
    }
    const info = await probeWith(tools.ffprobe, out, ctx);
    return {
      kind: 'bytes',
      data,
      mimeType: AUDIO_MIME[format],
      filename: `${opts.name ?? baseName(target)}.${format}`,
      durationSec: info.durationSec ?? 0,
    };
  });
}
