/**
 * Run a child process without a shell: arguments as an array, a hard timeout,
 * kill on abort, and capped output so a chatty process cannot fill memory.
 */
import { spawn } from 'node:child_process';
import type { Env } from '@vid2context/core';

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Child environment. Omitted: inherit the parent's. */
  env?: Env;
  /** Bytes kept from the end of stdout and of stderr. Default 64 KiB. */
  capBytes?: number;
  /** Called with every stderr chunk (for progress logs). */
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  ms: number;
}

/** Thrown when the executable itself cannot be started (ENOENT, EACCES). */
export class SpawnError extends Error {
  readonly errno: string;
  constructor(file: string, errno: string, cause: unknown) {
    super(`Cannot run ${file}: ${errno}`, { cause });
    this.name = 'SpawnError';
    this.errno = errno;
  }
}

function tail(buf: string, cap: number): string {
  return buf.length > cap ? buf.slice(buf.length - cap) : buf;
}

export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const cap = opts.capBytes ?? 64 * 1024;
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv | undefined,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout = tail(stdout + d, cap);
    });
    child.stderr.on('data', (d: string) => {
      stderr = tail(stderr + d, cap);
      opts.onStderr?.(d);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SpawnError(file, err.code ?? 'spawn-failed', err));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(opts.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      resolvePromise({ code, signal, stdout, stderr, timedOut, aborted, ms: Date.now() - started });
    });
  });
}

/** Run and return trimmed stdout, or null when the command is missing or fails. For probes like nvidia-smi. */
export async function probe(file: string, args: string[], env?: Env, timeoutMs = 10_000): Promise<string | null> {
  try {
    const r = await run(file, args, { env, timeoutMs });
    return r.code === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}
