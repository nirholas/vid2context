/**
 * Node entry: decodes audio with ffmpeg (FFMPEG_PATH, then PATH) to raw
 * 16 kHz mono float samples and caches models under
 * <VID2CONTEXT_HOME or ./.vid2context>/models/transformers/.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { type AudioInput, type Ctx, errorFromResponse, Vid2ContextError } from '@vid2context/core';
import { createTransformersProvider, type RuntimeHooks, SAMPLE_RATE } from './index.ts';

export * from './index.ts';

/** Directory for downloaded Transformers.js models. */
export function modelCacheDir(env: Ctx['env'], cwd: string = process.cwd()): string {
  const home = env.VID2CONTEXT_HOME?.trim() ? resolve(cwd, env.VID2CONTEXT_HOME.trim()) : resolve(cwd, '.vid2context');
  return resolve(home, 'models', 'transformers');
}

async function audioBytes(audio: AudioInput, ctx: Ctx): Promise<Uint8Array> {
  if (audio.kind === 'bytes') return audio.data;
  const res = await ctx.fetch(audio.url, { signal: ctx.signal });
  if (!res.ok) throw await errorFromResponse(res, 'transformers: audio download');
  return new Uint8Array(await res.arrayBuffer());
}

/** Decode any container ffmpeg understands into 16 kHz mono float32 samples. */
export async function decodeWithFfmpeg(audio: AudioInput, ctx: Ctx): Promise<Float32Array> {
  const input = await audioBytes(audio, ctx);
  const bin = ctx.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'];
  return await new Promise<Float32Array>((ok, fail) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], signal: ctx.signal });
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
    child.stdin.on('error', () => {
      // ffmpeg may close stdin early on bad input; the close handler reports it.
    });
    child.stdin.end(input);
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
