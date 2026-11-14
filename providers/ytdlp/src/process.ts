/**
 * Child process runner for yt-dlp. No shell ever: arguments go to spawn as an
 * array. Each run has a timeout, honours ctx.signal by killing the whole
 * process tree, keeps only the tail of stderr (the ERROR lines come last), and
 * caps stdout. A per-process semaphore bounds how many yt-dlp processes run
 * at once (YTDLP_CONCURRENCY, default 2).
 */
import { spawn } from 'node:child_process';
import { type Ctx, type Env, Vid2ContextError } from '@vid2context/core';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs: number;
  /** Max stdout bytes kept before the run is failed. Default 64 MB. */
  maxStdout?: number;
  /** Max stderr bytes kept (the tail). Default 64 KB. */
  maxStderr?: number;
  cwd?: string;
  /** Label for errors, e.g. "yt-dlp metadata". */
  label: string;
}

const DEFAULT_STDOUT = 64 * 1024 * 1024;
const DEFAULT_STDERR = 64 * 1024;

let active = 0;
const waiting: (() => void)[] = [];

export function concurrencyLimit(env: Env): number {
  const n = Number(env.YTDLP_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

async function acquire(limit: number, signal?: AbortSignal): Promise<void> {
  while (active >= limit) {
    if (signal?.aborted) throw abortError(signal);
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

/** Only string values reach the child; ctx.env can hold undefined entries. */
export function childEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      // The child leads its own process group (detached), so -pid reaches ffmpeg and other helpers too.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

/** Run a binary with an argument array. Resolves with the exit code; rejects only on spawn failure, timeout or abort. */
export async function run(bin: string, args: string[], ctx: Ctx, opts: RunOptions): Promise<RunResult> {
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  await acquire(concurrencyLimit(ctx.env), ctx.signal);
  try {
    return await spawnOnce(bin, args, ctx, opts);
  } finally {
    release();
  }
}

function spawnOnce(bin: string, args: string[], ctx: Ctx, opts: RunOptions): Promise<RunResult> {
  const maxStdout = opts.maxStdout ?? DEFAULT_STDOUT;
  const maxStderr = opts.maxStderr ?? DEFAULT_STDERR;
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: childEnv(ctx.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
    });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    let failure: Error | null = null;

    const fail = (e: Error) => {
      if (failure) return;
      failure = e;
      killTree(child.pid);
    };
    const timer = setTimeout(() => {
      fail(
        new Vid2ContextError('timeout', `${opts.label} timed out after ${Math.round(opts.timeoutMs / 1000)} s.`, {
          hint: 'Raise YTDLP_TIMEOUT_SEC for long videos or slow networks.',
        }),
      );
    }, opts.timeoutMs);
    const onAbort = () => fail(ctx.signal ? abortError(ctx.signal) : new DOMException('Aborted', 'AbortError'));
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      outLen += chunk.length;
      if (outLen > maxStdout) {
        fail(new Vid2ContextError('too-large', `${opts.label} printed more than ${maxStdout} bytes.`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
      if (err.length > maxStderr) err = err.slice(err.length - maxStderr);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (e.code === 'ENOENT') {
        reject(
          new Vid2ContextError('no-provider', `${opts.label}: ${bin} was not found.`, {
            hint: 'Run `npx tsx providers/ytdlp/src/setup.ts` to install yt-dlp, or set YTDLP_PATH.',
            cause: e,
          }),
        );
        return;
      }
      reject(failure ?? e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err });
    });
  });
}
