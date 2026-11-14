/**
 * A cross-process file lock, so parallel vid2context processes (several CLI
 * runs, a server and an MCP server) never download ffmpeg twice. The lock is a
 * file created with O_EXCL that holds the owner's pid; a lock whose owner died
 * or that is older than `staleMs` is taken over.
 */
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Vid2ContextError } from '@vid2context/core';

export interface LockOptions {
  /** Give up waiting after this long. Default 20 minutes (a large download). */
  timeoutMs?: number;
  /** Take over a lock older than this. Default 30 minutes. */
  staleMs?: number;
  /** Poll interval while waiting. Default 500 ms. */
  pollMs?: number;
  signal?: AbortSignal;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const pid = Number(text.split('\n')[0]);
    return !pidAlive(pid) || Date.now() - st.mtimeMs > staleMs;
  } catch {
    // The owner removed it between our checks: try again right away.
    return true;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Run `fn` while holding the lock file at `path`. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const staleMs = opts.staleMs ?? 30 * 60_000;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      const fh = await open(path, 'wx');
      try {
        await fh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      } finally {
        await fh.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (await isStale(path, staleMs)) {
        await unlink(path).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new Vid2ContextError('timeout', `Timed out waiting for the lock ${path}.`, {
          hint: 'Another vid2context process holds it. Wait for it to finish, or delete the lock file if no other process is running.',
        });
      }
      await sleep(pollMs, opts.signal);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
  }
}
