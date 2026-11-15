/**
 * Node entry: decodes audio with ffmpeg (FFMPEG_PATH, then PATH) to raw
 * 16 kHz mono float samples and caches models under
 * <VID2CONTEXT_HOME or ./.vid2context>/models/transformers/.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type AudioInput, type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { createTransformersProvider, type RuntimeHooks, SAMPLE_RATE } from './index.ts';

export * from './index.ts';

/** Directory for downloaded Transformers.js models. */
export function modelCacheDir(env: Ctx['env'], cwd: string = process.cwd()): string {
  const home = env.VID2CONTEXT_HOME?.trim() ? resolve(cwd, env.VID2CONTEXT_HOME.trim()) : resolve(cwd, '.vid2context');
  return resolve(home, 'models', 'transformers');
}

/**
 * The longest one audio download or one ffmpeg decode may take. The CLI and
 * the MCP server often run without a request signal, so without this a stalled
 * download or a hung ffmpeg would block the transcription forever.
 */
export const DECODE_TIMEOUT_MS = 10 * 60_000;

async function audioBytes(audio: AudioInput, ctx: Ctx, timeoutMs: number): Promise<Uint8Array> {
  if (audio.kind === 'bytes') return audio.data;
  const res = await fetchWithTimeout(ctx, audio.url, {}, timeoutMs);
  if (!res.ok) throw await errorFromResponse(res, 'transformers: audio download');
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Decode any container ffmpeg understands into 16 kHz mono float32 samples.
 * The input goes through a temp file, not stdin: MP4 and M4A files often keep
 * their index (moov atom) at the end, which ffmpeg cannot seek to in a pipe.
 */
export async function decodeWithFfmpeg(audio: AudioInput, ctx: Ctx, opts: { timeoutMs?: number } = {}): Promise<Float32Array> {
  const timeoutMs = opts.timeoutMs ?? DECODE_TIMEOUT_MS;
  const dir = await mkdtemp(join(tmpdir(), 'v2c-transformers-'));
  try {
    const file = join(dir, 'input');
    await writeFile(file, await audioBytes(audio, ctx, timeoutMs));
    return await runFfmpeg(file, ctx, timeoutMs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runFfmpeg(file: string, ctx: Ctx, timeoutMs: number): Promise<Float32Array> {
  const bin = ctx.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    'f32le',
    'pipe:1',
  ];
  return new Promise<Float32Array>((resolveSamples, rejectSamples) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: ctx.signal });
    let settled = false;
    const timer = setTimeout(() => {
      fail(
        new Vid2ContextError(
          'timeout',
          `transformers: ffmpeg took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`,
          {
            hint: 'The file may be damaged or very long. Convert it to mp3 or wav first, or split it.',
          },
        ),
      );
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, timeoutMs);
    function ok(samples: Float32Array) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSamples(samples);
    }
    function fail(err: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectSamples(err);
    }
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => {
      err = (err + b.toString()).slice(-2000);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        fail(
          new Vid2ContextError('no-provider', `transformers: ffmpeg not found (${bin})`, {
            hint: 'Install ffmpeg or set FFMPEG_PATH to its full path.',
            cause: e,
          }),
        );
      } else fail(e);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        fail(
          new Vid2ContextError('upstream', `transformers: ffmpeg could not decode the audio (exit ${code}): ${err.trim()}`, {
            hint: 'Check that the file is a real audio or video file.',
          }),
        );
        return;
      }
      const buf = Buffer.concat(out);
      const copy = new Uint8Array(buf.byteLength - (buf.byteLength % 4));
      copy.set(buf.subarray(0, copy.byteLength));
      ok(new Float32Array(copy.buffer));
    });
  });
}

export const nodeHooks: RuntimeHooks = {
  runtime: 'node',
  decode: decodeWithFfmpeg,
  cacheDir: (ctx) => modelCacheDir(ctx.env),
  webgpuWorks: async () => false,
};

const provider = createTransformersProvider(nodeHooks);
export default provider;
