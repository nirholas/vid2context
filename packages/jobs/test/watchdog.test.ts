import { MemoryKv, MemoryStorage } from '@vid2context/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  contextKind,
  createJobQueue,
  type InProcessQueue,
  type ItemsJobResult,
  JobKinds,
  type JobRecord,
  MAX_RETRY_DELAY_MS,
  registerBuiltinKinds,
  retryDelayMs,
  startWatchdog,
  toSSE,
  watchdogLimits,
} from '../src/index.ts';
import { collect, gate, PLAYLIST, waitFor, youtubeCtx, youtubeRegistry } from './helpers.ts';

// The hangs below are the real failure this guards against: the recorded
// YouTube player request held open forever, the way an upstream that accepts
// the connection and never answers behaves. Everything else is replayed from
// recordings (helpers.ts).

const open: InProcessQueue[] = [];

function queueWith(opts: Partial<Parameters<typeof createJobQueue>[0]> & { ctx: ReturnType<typeof youtubeCtx> }): InProcessQueue {
  const q = createJobQueue({ registry: youtubeRegistry(), abortGraceMs: 50, ...opts });
  registerBuiltinKinds(q);
  open.push(q);
  return q;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((q) => q.close()));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stalled jobs', () => {
  it('stops a job whose upstream never answers, fails it as timeout, and frees the slot for the next job', async () => {
    const q = queueWith({
      ctx: youtubeCtx({ beforePlayer: (id) => (id === 'cCPsdFdlshc' ? new Promise<void>(() => {}) : undefined) }),
      concurrency: 1,
    });
    q.registerKind('context', contextKind, { maxAttempts: 1, stallSec: 0.2 });
    const stuck = await q.enqueue('context', 'cCPsdFdlshc');
    const next = await q.enqueue('context', 'jNQXAC9IVRw');

    const stuckEvents = await collect(q, stuck.id).done;
    expect(stuckEvents.at(-1)).toMatchObject({ type: 'error', data: { code: 'timeout' } });
    const failed = await q.get(stuck.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.message).toMatch(/made no progress for 0\.2 s/);
    // The last progress the handler reported is named, so the operator knows where it hung.
    expect(failed?.error?.message).toMatch(/The last progress was "/);
    expect(failed?.error?.hint).toMatch(/VID2CONTEXT_JOB_STALL_SEC/);

    await waitFor(async () => (await q.get(next.id))?.status === 'succeeded');
  });

  it('retries a stalled attempt, and the retry can succeed', async () => {
    // The first player request hangs until its signal aborts, the way the real fetch behaves
    // (replayFetch itself does not watch the signal while a response is pending).
    const ctx = youtubeCtx();
    const replay = ctx.fetch;
    let calls = 0;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/youtubei/v1/player') && ++calls === 1) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return replay(input, init);
    }) as typeof globalThis.fetch;
    const q = queueWith({ ctx: Object.assign(ctx, { fetch: Object.assign(fetch, { calls: replay.calls }) }) });
    q.registerKind('context', contextKind, { maxAttempts: 2, stallSec: 0.2, backoff: { baseMs: 10, maxMs: 10 } });
    const job = await q.enqueue('context', 'jNQXAC9IVRw');
    await waitFor(async () => (await q.get(job.id))?.status === 'succeeded');
    const rec = (await q.store.get(job.id)) as JobRecord;
    expect(rec.attempts).toBe(2);
    expect(
      rec.events.some((e) => e.type === 'progress' && /Attempt 1 of 2 failed \(timeout\)/.test(String(e.data.message))),
    ).toBe(true);
  });

  it('leaves a slow job alone while it keeps reporting progress', async () => {
    const q = queueWith({ ctx: youtubeCtx() });
    q.registerKind(
      'slow',
      async ({ progress }) => {
        for (let i = 0; i < 8; i++) {
          await sleep(60);
          progress({ done: i + 1, total: 8 });
        }
        return { steps: 8 };
      },
      { maxAttempts: 1, stallSec: 0.2 },
    );
    const job = await q.enqueue('slow', null);
    await waitFor(async () => (await q.get(job.id))?.status === 'succeeded');
    expect((await q.get(job.id))?.result).toEqual({ steps: 8 });
  });

  it('stops an attempt that runs past the overall timeout even while it reports progress', async () => {
    const q = queueWith({ ctx: youtubeCtx() });
    let sawAbort = false;
    q.registerKind(
      'long',
      async ({ progress, signal }) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
        });
        for (let i = 0; i < 100 && !signal.aborted; i++) {
          await sleep(20);
          progress({ done: i });
        }
        return null;
      },
      { maxAttempts: 1, timeoutSec: 0.15 },
    );
    const job = await q.enqueue('long', null);
    await waitFor(async () => (await q.get(job.id))?.status === 'failed');
    const failed = await q.get(job.id);
    expect(failed?.error).toMatchObject({ code: 'timeout' });
    expect(failed?.error?.message).toMatch(/ran longer than 0\.15 s/);
    // The handler's signal is aborted, so its fetches and child processes stop too.
    expect(sawAbort).toBe(true);
  });

  it('keeps the slot until an aborted handler settles, within the grace period', async () => {
    const order: string[] = [];
    const q = queueWith({ ctx: youtubeCtx(), concurrency: 1, abortGraceMs: 1_000 });
    q.registerKind(
      'stubborn',
      async () => {
        order.push('stubborn start');
        await sleep(150); // ignores its signal, like code that never checks it
        order.push('stubborn end');
        return null;
      },
      { maxAttempts: 1 },
    );
    q.registerKind(
      'next',
      async () => {
        order.push('next start');
        return null;
      },
      { maxAttempts: 1 },
    );
    const first = await q.enqueue('stubborn', null);
    await q.enqueue('next', null);
    await waitFor(() => order.includes('stubborn start'));
    expect((await q.cancel(first.id)).status).toBe('canceled');
    await q.idle();
    expect(order).toEqual(['stubborn start', 'stubborn end', 'next start']);
  });
});

describe('queue limits', () => {
  it('refuses new jobs with rate-limited once maxQueued jobs are waiting', async () => {
    const hold = gate();
    const q = queueWith({ ctx: youtubeCtx({ beforePlayer: () => hold.promise }), concurrency: 1, maxQueued: 2 });
    await q.enqueue('context', 'jNQXAC9IVRw'); // running
    await q.enqueue('context', 'jNQXAC9IVRw');
    await q.enqueue('context', 'jNQXAC9IVRw');
    await expect(q.enqueue('context', 'jNQXAC9IVRw')).rejects.toMatchObject({
      code: 'rate-limited',
      retryAfterSec: 30,
      hint: expect.stringMatching(/VID2CONTEXT_MAX_QUEUED_JOBS/),
    });
    hold.open();
    await q.idle();
    // Room again once the queue drains.
    await expect(q.enqueue('context', 'jNQXAC9IVRw')).resolves.toMatchObject({ status: 'queued' });
  });

  it('reads VID2CONTEXT_MAX_QUEUED_JOBS and rejects bad values', () => {
    const q = queueWith({ ctx: youtubeCtx({ env: { VID2CONTEXT_MAX_QUEUED_JOBS: '7' } }), autoStart: false });
    expect(q.maxQueued).toBe(7);
    expect(() => queueWith({ ctx: youtubeCtx({ env: { VID2CONTEXT_MAX_QUEUED_JOBS: '0' } }), autoStart: false })).toThrow(
      /VID2CONTEXT_MAX_QUEUED_JOBS/,
    );
  });

  it('caps an items job without a limit at VID2CONTEXT_MAX_PLAYLIST_ITEMS', async () => {
    const q = queueWith({ ctx: youtubeCtx({ env: { VID2CONTEXT_MAX_PLAYLIST_ITEMS: '2' } }), storage: new MemoryStorage() });
    const job = await q.enqueue('items', PLAYLIST, { concurrency: 1 });
    await waitFor(async () => (await q.get(job.id))?.status === 'succeeded');
    expect(((await q.get(job.id))?.result as ItemsJobResult | undefined)?.total).toBe(2);
    // A larger requested limit is clamped too.
    const asked = await q.enqueue('items', PLAYLIST, { limit: 50, concurrency: 1 });
    await waitFor(async () => (await q.get(asked.id))?.status === 'succeeded');
    expect(((await q.get(asked.id))?.result as ItemsJobResult | undefined)?.total).toBe(2);
  });
});

describe('retry delays', () => {
  const backoff = { baseMs: 2_000, maxMs: 300_000, blockedMs: 900_000 };

  it('honours a longer Retry-After but never waits more than an hour', () => {
    expect(retryDelayMs({ code: 'rate-limited', message: '', retryAfterSec: 120 }, 1, backoff, () => 0)).toBe(120_000);
    expect(retryDelayMs({ code: 'rate-limited', message: '', retryAfterSec: 10 * 86_400 }, 1, backoff, () => 0)).toBe(
      MAX_RETRY_DELAY_MS,
    );
    expect(retryDelayMs({ code: 'rate-limited', message: '', retryAfterSec: Number.NaN }, 1, backoff, () => 0)).toBe(1_000);
  });
});

describe('watchdog settings', () => {
  it('takes the kind first, then the env, then the defaults, and rejects bad values', () => {
    expect(watchdogLimits({})).toEqual({ stallSec: 1800, timeoutSec: 0 });
    expect(watchdogLimits({ VID2CONTEXT_JOB_STALL_SEC: '60', VID2CONTEXT_JOB_TIMEOUT_SEC: '3600' })).toEqual({
      stallSec: 60,
      timeoutSec: 3600,
    });
    expect(watchdogLimits({ VID2CONTEXT_JOB_STALL_SEC: '60' }, { stallSec: 0 })).toEqual({ stallSec: 0, timeoutSec: 0 });
    expect(() => watchdogLimits({ VID2CONTEXT_JOB_STALL_SEC: 'soon' })).toThrow(/VID2CONTEXT_JOB_STALL_SEC/);
    expect(() => new JobKinds().register('x', async () => null, { stallSec: -1 })).toThrow(/stallSec/);
  });

  it('a bad env value falls back to the defaults instead of failing every job', async () => {
    const q = queueWith({ ctx: youtubeCtx({ env: { VID2CONTEXT_JOB_STALL_SEC: 'soon' } }) });
    const job = await q.enqueue('context', 'jNQXAC9IVRw');
    await waitFor(async () => (await q.get(job.id))?.status === 'succeeded');
  });

  it('with both checks off it never aborts and sets no timer', async () => {
    const dog = startWatchdog('x', { stallSec: 0, timeoutSec: 0 });
    await sleep(20);
    expect(dog.signal.aborted).toBe(false);
    dog.stop();
  });
});

describe('job streams', () => {
  it('closes with the final event when the job runs in another process sharing the store', async () => {
    const kv = new MemoryKv();
    const hold = gate();
    const runner = queueWith({ ctx: youtubeCtx({ beforePlayer: () => hold.promise }), kv });
    // The API process: same store, its own (empty) event hub, runs nothing itself.
    const api = queueWith({ ctx: youtubeCtx(), kv, autoStart: false });
    const job = await runner.enqueue('context', 'jNQXAC9IVRw');
    await waitFor(async () => (await api.get(job.id))?.status === 'running');

    const res = await toSSE(api, job.id, { heartbeatMs: 20 });
    const text = res.text();
    hold.open();
    const body = await text;
    expect(body).toMatch(/event: done\n/);
    expect(body).toMatch(/: heartbeat/);
  });
});
