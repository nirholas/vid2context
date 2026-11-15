import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ffmpegConcurrency, runProcess } from '../src/process.ts';
import { Semaphore } from '../src/semaphore.ts';

// Real child processes (node itself) stand in for ffmpeg: the semaphore does not care what runs.
const NODE = process.execPath;
const dir = mkdtempSync(join(tmpdir(), 'v2c-ffsem-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sleepArgs = (ms: number) => ['-e', `setTimeout(() => {}, ${ms})`];
const touchArgs = (file: string) => ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'x')`];

describe('ffmpegConcurrency', () => {
  it('reads FFMPEG_CONCURRENCY and defaults to half the CPUs, at least 1', () => {
    expect(ffmpegConcurrency({ FFMPEG_CONCURRENCY: '3' })).toBe(3);
    const fallback = Math.max(1, Math.floor(availableParallelism() / 2));
    expect(ffmpegConcurrency({})).toBe(fallback);
    expect(ffmpegConcurrency({ FFMPEG_CONCURRENCY: '0' })).toBe(fallback);
    expect(ffmpegConcurrency({ FFMPEG_CONCURRENCY: 'many' })).toBe(fallback);
  });
});

describe('runProcess semaphore', () => {
  it('never runs more than FFMPEG_CONCURRENCY processes at once', async () => {
    const env = { FFMPEG_CONCURRENCY: '2' };
    // Each child prints its own start and end time, so the overlap is measured where the work happens.
    const script = 'const s = Date.now(); setTimeout(() => console.log(s, Date.now()), 150)';
    const results = await Promise.all(
      Array.from({ length: 5 }, () => runProcess(NODE, ['-e', script], { label: 'sleep', env, captureStdout: true })),
    );
    const spans = results.map((r) => new TextDecoder().decode(r.stdout).trim().split(' ').map(Number) as [number, number]);
    const peak = Math.max(...spans.map(([start]) => spans.filter(([s, e]) => s <= start && start < e).length));
    expect(peak).toBe(2);
  });

  it('a caller aborted while queued rejects at once and never spawns', async () => {
    const env = { FFMPEG_CONCURRENCY: '1' };
    const marker = join(dir, 'queued-ran');
    const holder = runProcess(NODE, sleepArgs(600), { label: 'holder', env });
    const controller = new AbortController();
    const queued = runProcess(NODE, touchArgs(marker), { label: 'queued', env, signal: controller.signal });
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('caller gave up')), 50);
    await expect(queued).rejects.toThrow('caller gave up');
    expect(Date.now() - started).toBeLessThan(400);
    await holder;
    // The aborted waiter left the queue, so the next caller gets the slot.
    const after = join(dir, 'after-ran');
    await runProcess(NODE, touchArgs(after), { label: 'after', env });
    expect(existsSync(after)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('Semaphore', () => {
  it('hands slots to waiters in order and skips aborted ones', async () => {
    const sem = new Semaphore();
    const release = await sem.acquire(1);
    const controller = new AbortController();
    const a = sem.acquire(1, controller.signal);
    const b = sem.acquire(1);
    expect(sem.queued).toBe(2);
    controller.abort();
    await expect(a).rejects.toBeTruthy();
    expect(sem.queued).toBe(1);
    release();
    const releaseB = await b;
    expect(sem.inUse).toBe(1);
    releaseB();
    releaseB();
    expect(sem.inUse).toBe(0);
  });

  it('run() refuses an already aborted signal without calling fn', async () => {
    const sem = new Semaphore();
    let called = false;
    await expect(
      sem.run(1, AbortSignal.abort(), async () => {
        called = true;
      }),
    ).rejects.toBeTruthy();
    expect(called).toBe(false);
    expect(sem.inUse).toBe(0);
  });
});
