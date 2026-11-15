import { createContext, Vid2ContextError } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { run, Semaphore, waitingLimit } from '../src/process.ts';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

describe('Semaphore', () => {
  it('passes a slot past a waiter that aborted, so later waiters still run', async () => {
    const sem = new Semaphore();
    await sem.acquire(1, 10);
    const gone = new AbortController();
    const aborted = sem.acquire(1, 10, gone.signal);
    const live = sem.acquire(1, 10);
    gone.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(sem.queued).toBe(1);
    sem.release();
    await live;
    expect(sem.inUse).toBe(1);
    expect(sem.queued).toBe(0);
    sem.release();
    expect(sem.inUse).toBe(0);
  });

  it('refuses to queue past the waiting limit with a busy error and Retry-After', async () => {
    const sem = new Semaphore();
    await sem.acquire(1, 1);
    const waiter = sem.acquire(1, 1);
    const err = await sem.acquire(1, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err).toMatchObject({ code: 'rate-limited', retryAfterSec: 5 });
    expect((err as Vid2ContextError).hint).toContain('YTDLP_MAX_WAITING');
    sem.release();
    await waiter;
    sem.release();
  });

  it('reads YTDLP_MAX_WAITING with a default of 64', () => {
    expect(waitingLimit({})).toBe(64);
    expect(waitingLimit({ YTDLP_MAX_WAITING: '0' })).toBe(0);
    expect(waitingLimit({ YTDLP_MAX_WAITING: 'x' })).toBe(64);
  });
});

describe('run with real processes', () => {
  const hold = ['-e', 'setTimeout(() => {}, 60000)'];

  it('never spawns for a call aborted while it waited for a slot', async () => {
    const env = { ...process.env, YTDLP_CONCURRENCY: '1' } as Record<string, string>;
    const first = new AbortController();
    const second = new AbortController();
    const holder = run(process.execPath, hold, createContext({ runtime: 'node', env, log: quiet, signal: first.signal }), {
      timeoutMs: 30_000,
      label: 'holder',
    });
    let spawned = false;
    const waiter = run(
      process.execPath,
      ['-e', 'process.stdout.write("ran")'],
      createContext({ runtime: 'node', env, log: quiet, signal: second.signal }),
      { timeoutMs: 30_000, label: 'waiter', onStdoutLine: () => (spawned = true) },
    );
    second.abort();
    const started = Date.now();
    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1000);
    first.abort();
    await expect(holder).rejects.toMatchObject({ name: 'AbortError' });
    // The slot is free again: a new call runs right away.
    const res = await run(
      process.execPath,
      ['-e', 'process.stdout.write("ok")'],
      createContext({ runtime: 'node', env, log: quiet }),
      {
        timeoutMs: 30_000,
        label: 'after',
      },
    );
    expect(res.stdout).toBe('ok');
    expect(spawned).toBe(false);
  });

  it('names the caller env var in the timeout hint', async () => {
    const err = await run(
      process.execPath,
      hold,
      createContext({ runtime: 'node', env: process.env as Record<string, string>, log: quiet }),
      {
        timeoutMs: 200,
        label: 'download',
        ownQueue: true,
        timeoutEnvVar: 'VID2CONTEXT_DOWNLOAD_TIMEOUT_SEC',
      },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'timeout' });
    expect((err as Vid2ContextError).hint).toContain('VID2CONTEXT_DOWNLOAD_TIMEOUT_SEC');
  });
});
