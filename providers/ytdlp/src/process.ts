/**
 * Child process runner for yt-dlp. No shell ever: arguments go to spawn as an
 * array. Each run has a timeout, honours ctx.signal by killing the whole
 * process tree, keeps only the tail of stderr (the ERROR lines come last), and
 * caps stdout. A per-process semaphore bounds how many yt-dlp processes run
 * at once (YTDLP_CONCURRENCY, default 2) and how many calls may wait for one
 * (YTDLP_MAX_WAITING, default 64).
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
  /**
   * Called with each complete stdout line as it arrives (progress templates).
   * Lines are still collected into `stdout` unless `discardStdout` is set.
   */
  onStdoutLine?: (line: string) => void;
  /** Called with each complete stderr line (postprocessor progress is printed there). */
  onStderrLine?: (line: string) => void;
  /** Do not keep stdout (long runs that only report through onStdoutLine). */
  discardStdout?: boolean;
  /**
   * Skip the shared YTDLP_CONCURRENCY semaphore. Media downloads take
   * minutes and queue under their own limit, so they must not hold the slots
   * that metadata and caption calls need.
   */
  ownQueue?: boolean;
  /** The env var that sets this run's timeout, named in the timeout hint. Default YTDLP_TIMEOUT_SEC. */
  timeoutEnvVar?: string;
}

const DEFAULT_STDOUT = 64 * 1024 * 1024;
const DEFAULT_STDERR = 64 * 1024;

export function concurrencyLimit(env: Env): number {
  const n = Number(env.YTDLP_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

/** Calls allowed to wait for a slot (YTDLP_MAX_WAITING, default 64); one more is refused as busy. */
export function waitingLimit(env: Env): number {
  const raw = env.YTDLP_MAX_WAITING?.trim();
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : 64;
}

interface Waiter {
  grant: () => void;
}

/**
 * A counting semaphore whose slots pass straight from the releasing call to
 * the next waiter, so a slot can never be lost: a waiter that aborts leaves
 * the queue at once (its promise rejects), and only live waiters are woken.
 * The queue is bounded; past it, acquire fails with a `rate-limited` (busy)
 * error instead of piling up work.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  get inUse(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(limit: number, maxWaiting: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    if (this.active < limit && this.waiting.length === 0) {
      this.active++;
      return;
    }
    if (this.waiting.length >= maxWaiting) {
      throw new Vid2ContextError(
        'rate-limited',
        `yt-dlp is busy: ${this.active} calls are running and ${this.waiting.length} are waiting.`,
        {
          hint: 'Retry in a few seconds, or raise YTDLP_CONCURRENCY (parallel yt-dlp processes) or YTDLP_MAX_WAITING (calls allowed to queue).',
          retryAfterSec: 5,
        },
      );
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(waiter);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(abortError(signal as AbortSignal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  /** Hand the slot to the next waiter, or free it. */
  release(): void {
    const next = this.waiting.shift();
    if (next) next.grant();
    else this.active = Math.max(0, this.active - 1);
  }
}

const slots = new Semaphore();

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
  if (opts.ownQueue) return spawnOnce(bin, args, ctx, opts);
  await slots.acquire(concurrencyLimit(ctx.env), waitingLimit(ctx.env), ctx.signal);
  try {
    return await spawnOnce(bin, args, ctx, opts);
  } finally {
    slots.release();
  }
}

function spawnOnce(bin: string, args: string[], ctx: Ctx, opts: RunOptions): Promise<RunResult> {
  // An abort that landed while waiting for a slot: an abort listener added now would never fire.
  if (ctx.signal?.aborted) return Promise.reject(abortError(ctx.signal));
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
    let partial = '';
    let errPartial = '';

    const fail = (e: Error) => {
      if (failure) return;
      failure = e;
      killTree(child.pid);
    };
    const timer = setTimeout(() => {
      fail(
        new Vid2ContextError('timeout', `${opts.label} timed out after ${Math.round(opts.timeoutMs / 1000)} s.`, {
          hint: `Raise ${opts.timeoutEnvVar ?? 'YTDLP_TIMEOUT_SEC'} for long videos or slow networks.`,
        }),
      );
    }, opts.timeoutMs);
    const onAbort = () => fail(ctx.signal ? abortError(ctx.signal) : new DOMException('Aborted', 'AbortError'));
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (opts.onStdoutLine) {
        partial += chunk.toString('utf8');
        const lines = partial.split(/\r?\n|\r/);
        partial = lines.pop() ?? '';
        for (const line of lines) if (line) opts.onStdoutLine(line);
      }
      if (opts.discardStdout) return;
      outLen += chunk.length;
      if (outLen > maxStdout) {
        fail(new Vid2ContextError('too-large', `${opts.label} printed more than ${maxStdout} bytes.`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (opts.onStderrLine) {
        errPartial += text;
        const lines = errPartial.split(/\r?\n|\r/);
        errPartial = lines.pop() ?? '';
        for (const line of lines) if (line) opts.onStderrLine(line);
      }
      err += text;
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
      if (partial && opts.onStdoutLine) opts.onStdoutLine(partial);
      if (errPartial && opts.onStderrLine) opts.onStderrLine(errPartial);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err });
    });
  });
}
