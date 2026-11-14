/**
 * Minimal ffmpeg wrapper for live chunks (Node only). Media segments arrive
 * as bytes; one ffmpeg run per chunk reads them from stdin, cuts the chunk's
 * time span and writes 16 kHz mono 16-bit WAV to stdout, so nothing touches
 * the disk. When @vid2context/ffmpeg (prompt 12) lands, the integration pass
 * can swap its binary lookup in here; the AudioExtractor contract stays.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type Env, Vid2ContextError } from '@vid2context/core';
import type { AudioExtractor, ChunkMedia } from './types.ts';

export const FFMPEG_MISSING_HINT =
  'Install ffmpeg (https://ffmpeg.org/download.html, or your package manager: apt install ffmpeg, brew install ffmpeg) ' +
  'or set FFMPEG_PATH to the ffmpeg binary.';

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate ffmpeg: FFMPEG_PATH, then every directory on PATH, then ~/.local/bin.
 * Pass `ctx.env` (on Node it carries the process PATH), so a configured
 * FFMPEG_PATH wins.
 */
export function findFfmpeg(env: Env, home = homedir()): string | null {
  const pathVar = env.PATH ?? env.Path ?? '';
  const configured = env.FFMPEG_PATH?.trim();
  if (configured) return executable(configured) ? configured : null;
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const dirs = [...pathVar.split(delimiter).filter(Boolean), join(home, '.local', 'bin')];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}

/** Fill in the RIFF and data chunk sizes that ffmpeg leaves unset when it writes WAV to a pipe. */
export function fixWavHeader(wav: Uint8Array): Uint8Array {
  if (wav.byteLength < 12) return wav;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o: number) => String.fromCharCode(wav[o] ?? 0, wav[o + 1] ?? 0, wav[o + 2] ?? 0, wav[o + 3] ?? 0);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return wav;
  view.setUint32(4, wav.byteLength - 8, true);
  let off = 12;
  while (off + 8 <= wav.byteLength) {
    const id = tag(off);
    if (id === 'data') {
      view.setUint32(off + 4, wav.byteLength - off - 8, true);
      break;
    }
    const size = view.getUint32(off + 4, true);
    off += 8 + size + (size % 2);
  }
  return wav;
}

const STDERR_CAP = 4000;

function runFfmpeg(bin: string, args: string[], input: Uint8Array, signal: AbortSignal | undefined, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const out: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const finish = (err: unknown, value?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value ?? new Uint8Array());
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Vid2ContextError('timeout', `ffmpeg did not finish within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr = (stderr + b.toString('utf8')).slice(0, STDERR_CAP);
    });
    child.on('error', (err) =>
      finish(new Vid2ContextError('no-provider', `Could not start ffmpeg (${bin}): ${err.message}`, { hint: FFMPEG_MISSING_HINT })),
    );
    child.on('close', (code) => {
      if (code === 0) finish(null, new Uint8Array(Buffer.concat(out)));
      else {
        finish(
          new Vid2ContextError('upstream', `ffmpeg exited with code ${code}: ${stderr.trim().slice(-500)}`, {
            hint: 'The stream sent media ffmpeg could not decode. If it keeps happening, report the stream URL.',
          }),
        );
      }
    });
    // ffmpeg may exit before reading everything (for example after -t); ignore the resulting EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  });
}

/**
 * An AudioExtractor backed by a local ffmpeg. Throws `no-provider` with an
 * install hint when no binary is found.
 */
export function createFfmpegExtractor(opts: { env: Env; path?: string; timeoutMs?: number }): AudioExtractor {
  let bin: string | null | undefined = opts.path;
  return {
    id: 'ffmpeg',
    async extract(media: ChunkMedia, signal?: AbortSignal) {
      if (bin === undefined) bin = findFfmpeg(opts.env);
      if (!bin) {
        throw new Vid2ContextError('no-provider', 'Live transcription needs ffmpeg, and none was found.', {
          hint: FFMPEG_MISSING_HINT,
        });
      }
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-ss',
        media.offsetSec.toFixed(3),
        '-t',
        media.durationSec.toFixed(3),
        '-vn',
        '-sn',
        '-dn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        'pipe:1',
      ];
      const wav = await runFfmpeg(bin, args, media.data, signal, opts.timeoutMs ?? 60_000);
      return {
        kind: 'bytes',
        data: fixWavHeader(wav),
        mimeType: 'audio/wav',
        filename: media.filename,
        durationSec: media.durationSec,
      };
    },
  };
}
