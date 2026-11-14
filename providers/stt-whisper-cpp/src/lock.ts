/**
 * A cross-process file lock in .vid2context/locks/, so two processes never
 * build whisper.cpp or download the same model at once. The lock file holds
 * the owner's pid; a lock whose owner is gone is taken over.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Env, Vid2ContextError } from '@vid2context/core';
import { locksDir } from './paths.ts';

function ownerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryAcquire(file: string): boolean {
  try {
    writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  let pid = Number.NaN;
  try {
    pid = Number(readFileSync(file, 'utf8').trim());
  } catch {
    return false;
  }
  if (ownerAlive(pid)) return false;
  rmSync(file, { force: true });
  try {
    writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hold the named lock while `fn` runs. Waits (polling) while another live
 * process holds it, up to `waitMs`.
 */
export async function withLock<T>(
  env: Env,
  name: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; signal?: AbortSignal; onWait?: () => void } = {},
): Promise<T> {
  const dir = locksDir(env);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.lock`);
  const deadline = Date.now() + (opts.waitMs ?? 60 * 60 * 1000);
  let warned = false;
  while (!tryAcquire(file)) {
    if (!warned) {
      opts.onWait?.();
      warned = true;
    }
    if (Date.now() > deadline) {
      throw new Vid2ContextError('timeout', `Timed out waiting for the lock ${file}.`, {
        hint: 'Another vid2context process is installing whisper.cpp or downloading a model. Wait for it, or delete the lock file if that process is gone.',
      });
    }
    await sleep(500, undefined, { signal: opts.signal });
  }
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}
