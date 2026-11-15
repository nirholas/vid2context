import { errorFromResponse, MemoryKv, MemoryStorage, Vid2ContextError } from '@vid2context/core';
import { parseSrv3 } from '@vid2context/provider-youtube';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ContextJobResult,
  createJobQueue,
  type InProcessQueue,
  type ItemsJobResult,
  type JobRecord,
  registerBuiltinKinds,
} from '../src/index.ts';
import {
  collect,
  gate,
  jobsFixture,
  PLAYLIST,
  PLAYLIST_FIRST3,
  waitFor,
  youtubeCtx,
  youtubeRegistry,
  ytFixture,
} from './helpers.ts';

const open: InProcessQueue[] = [];

function queueWith(opts: Partial<Parameters<typeof createJobQueue>[0]> & { ctx: ReturnType<typeof youtubeCtx> }): InProcessQueue {
  const q = createJobQueue({ registry: youtubeRegistry(), ...opts });
  registerBuiltinKinds(q);
  open.push(q);
  return q;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((q) => q.close()));
});

describe('context job', () => {
  it('runs the real pipeline on recorded responses, reports stages in order and saves the context', async () => {
    const storage = new MemoryStorage();
    const q = queueWith({ ctx: youtubeCtx(), storage });
    const job = await q.enqueue('context', 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(job.status).toBe('queued');
    expect(job.id).toMatch(/^job_[A-Za-z0-9_-]{22}$/);
    const { done } = collect(q, job.id);
    const events = await done;

    const final = await q.get(job.id);
    expect(final?.status).toBe('succeeded');
    const result = final?.result as ContextJobResult;
    expect(result.video.id).toBe('youtube:jNQXAC9IVRw');
    expect(result.video.title).toBe('Me at the zoo');
    expect(result.video.origin).toBe('creator-captions');
    expect(result.segments).toBeGreaterThan(0);

    const stages = events
      .filter((e) => e.type === 'progress')
      .map((e) => String((e.data as { message?: string }).message).split(':')[0]);
    expect(stages).toEqual(['resolve', 'metadata', 'captions', 'saving', 'done']);
    expect(events.at(-1)?.type).toBe('done');
    // Event ids are monotonic per job.
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i + 1));

    const saved = await storage.getContext('youtube:jNQXAC9IVRw');
    expect(saved?.transcript.segments.length).toBe(result.segments);
  });

  it('fails an unsupported input once, without retrying', async () => {
    const q = queueWith({ ctx: youtubeCtx() });
    const job = await q.enqueue('context', 'https://vimeo.com/76979871');
    await collect(q, job.id).done;
    const rec = (await q.store.get(job.id)) as JobRecord;
    expect(rec.status).toBe('failed');
    expect(rec.error?.code).toBe('unsupported-input');
    expect(rec.attempts).toBe(1);
  });

  it('rejects unknown kinds before queueing, listing the registered ones', async () => {
    const q = queueWith({ ctx: youtubeCtx() });
    const err = await q.enqueue('transcode', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('bad-request');
    expect((err as Vid2ContextError).hint).toBe('Registered kinds: bundle, context, items.');
    expect((await q.list()).jobs).toHaveLength(0);
  });
});

describe('items job', () => {
  it('expands a recorded playlist and records per-item outcomes', async () => {
    const storage = new MemoryStorage();
    const q = queueWith({ ctx: youtubeCtx(), storage });
    const job = await q.enqueue('items', PLAYLIST, { limit: 3, concurrency: 1 });
    const events = await collect(q, job.id).done;

    const items = events
      .filter((e) => e.type === 'item')
      .map((e) => e.data as { id: string; outcome: string; error?: { code: string } });
    expect(items.map((i) => i.id)).toEqual(PLAYLIST_FIRST3);
    expect(items.map((i) => i.outcome)).toEqual(['ok', 'error', 'error']);
    // Ay22n7jR2j4 answered LOGIN_REQUIRED; cBsRvPSWXQk's only track answered HTTP 429 (the block page), so the
    // run reports the block, whose hint says how to get past it.
    expect(items[1]?.error?.code).toBe('unavailable');
    expect(items[2]?.error?.code).toBe('blocked');

    const final = await q.get(job.id);
    expect(final?.status).toBe('succeeded');
    const result = final?.result as ItemsJobResult;
    expect(result).toMatchObject({ input: PLAYLIST, total: 3, succeeded: 1, failed: 2 });
    expect(final?.progress).toMatchObject({ done: 3, total: 3 });
    expect(await storage.getContext('youtube:jNQXAC9IVRw')).not.toBeNull();
  });
});

describe('retries', () => {
  it('retries a recorded HTTP 429 with backoff, then succeeds', async () => {
    const ctx = youtubeCtx();
    const url = 'https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en&fmt=srv3';
    const calls: number[] = [];
    let n = 0;
    const replay = async () => {
      calls.push(Date.now());
      n += 1;
      // First the real 429 page YouTube served, then the real track.
      return n === 1
        ? new Response(ytFixture('timedtext-429-blocked.html'), { status: 429 })
        : new Response(ytFixture('timedtext-jNQXAC9IVRw-en.srv3.xml'), { status: 200 });
    };
    const q = queueWith({
      ctx: { ...ctx, fetch: Object.assign(replay, { calls: [] }) as unknown as typeof ctx.fetch },
      random: () => 0,
    });
    q.registerKind(
      'timedtext',
      async ({ ctx: jobCtx, input }) => {
        const res = await jobCtx.fetch(String(input));
        if (!res.ok) throw await errorFromResponse(res, 'YouTube timedtext');
        return { segments: parseSrv3(await res.text()).length };
      },
      { maxAttempts: 3, backoff: { baseMs: 200 } },
    );
    const job = await q.enqueue('timedtext', url);
    const events = await collect(q, job.id).done;
    const rec = (await q.store.get(job.id)) as JobRecord;
    expect(rec.status).toBe('succeeded');
    expect(rec.attempts).toBe(2);
    expect((rec.result as { segments: number }).segments).toBeGreaterThan(0);
    // random() = 0 gives the lower bound of equal jitter: half of baseMs.
    expect((calls[1] as number) - (calls[0] as number)).toBeGreaterThanOrEqual(95);
    const retryMsg = events.find(
      (e) => e.type === 'progress' && String((e.data as { message?: string }).message).includes('retrying'),
    );
    expect(retryMsg?.data).toMatchObject({ message: 'Attempt 1 of 3 failed (rate-limited); retrying in 1 s.' });
  });

  it('gives up after maxAttempts and keeps the last error', async () => {
    let n = 0;
    const ctx = youtubeCtx();
    const always429 = async () => {
      n += 1;
      return new Response(jobsFixture('timedtext-cBsRvPSWXQk-en-asr-429.html'), { status: 429 });
    };
    const q = queueWith({ ctx: { ...ctx, fetch: always429 as unknown as typeof ctx.fetch }, random: () => 0 });
    q.registerKind(
      'timedtext',
      async ({ ctx: jobCtx, input }) => {
        const res = await jobCtx.fetch(String(input));
        if (!res.ok) throw await errorFromResponse(res, 'YouTube timedtext');
        return null;
      },
      { maxAttempts: 2, backoff: { baseMs: 20 } },
    );
    const job = await q.enqueue('timedtext', 'https://www.youtube.com/api/timedtext?v=cBsRvPSWXQk&lang=en&kind=asr&fmt=srv3');
    await collect(q, job.id).done;
    const rec = (await q.store.get(job.id)) as JobRecord;
    expect(rec.status).toBe('failed');
    expect(rec.error?.code).toBe('rate-limited');
    expect(rec.attempts).toBe(2);
    expect(n).toBe(2);
  });
});

describe('restart resume', () => {
  it('a job stopped by close() runs again on a new queue sharing the KV, and completes once', async () => {
    const kv = new MemoryKv();
    const storage = new MemoryStorage();
    const held = gate();
    let reached = false;
    const first = queueWith({
      ctx: youtubeCtx({
        beforePlayer: () => {
          reached = true;
          return held.promise; // Never opened: the request hangs until the queue stops.
        },
      }),
      kv,
      storage,
    });
    const job = await first.enqueue('context', 'jNQXAC9IVRw');
    await waitFor(() => reached);
    expect((await first.get(job.id))?.status).toBe('running');
    await first.close();
    expect((await first.store.get(job.id))?.status).toBe('queued');

    const second = queueWith({ ctx: youtubeCtx(), kv, storage });
    const events = await collect(second, job.id).done;
    const rec = (await second.store.get(job.id)) as JobRecord;
    expect(rec.status).toBe('succeeded');
    expect(rec.attempts).toBe(2);
    expect(rec.events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    held.open();
  });

  it('a job left running by a crash goes back to queued and runs on the next start', async () => {
    const kv = new MemoryKv();
    let reached = false;
    // The first queue is abandoned mid-job, as a crashed process would be: its record stays `running`.
    const crashed = createJobQueue({
      registry: youtubeRegistry(),
      ctx: youtubeCtx({
        beforePlayer: () => {
          reached = true;
          return new Promise<void>(() => {});
        },
      }),
      kv,
    });
    registerBuiltinKinds(crashed);
    const job = await crashed.enqueue('context', 'jNQXAC9IVRw');
    await waitFor(() => reached);
    expect((await crashed.store.get(job.id))?.status).toBe('running');

    // The record was written moments ago, so the new process first treats it as running elsewhere,
    // then takes it over once no heartbeat has arrived for 3 x heartbeatMs.
    const next = queueWith({ ctx: youtubeCtx(), kv, heartbeatMs: 20 });
    await waitFor(async () => (await next.store.get(job.id))?.status === 'succeeded');
    const rec = (await next.store.get(job.id)) as JobRecord;
    expect(rec.status).toBe('succeeded');
    expect(rec.events.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('cancels a queued job without running it and aborts a running one', async () => {
    let reached = false;
    const seen: string[] = [];
    const q = queueWith({
      ctx: youtubeCtx({
        beforePlayer: (videoId) => {
          seen.push(videoId);
          reached = true;
          return new Promise<void>(() => {});
        },
      }),
      concurrency: 1,
    });
    const running = await q.enqueue('context', 'jNQXAC9IVRw');
    const queued = await q.enqueue('context', 'cCPsdFdlshc');
    await waitFor(() => reached);

    const c1 = await q.cancel(queued.id);
    expect(c1.status).toBe('canceled');
    expect(c1.error?.code).toBe('canceled');

    const c2 = await q.cancel(running.id);
    expect(c2.status).toBe('canceled');
    await q.idle();
    expect(seen).toEqual(['jNQXAC9IVRw']);
    const rec = (await q.store.get(running.id)) as JobRecord;
    expect(rec.events.at(-1)).toMatchObject({ type: 'error', data: { code: 'canceled' } });
    // Cancelling again returns the final state unchanged.
    expect((await q.cancel(running.id)).status).toBe('canceled');
    await expect(q.cancel('job_AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('persistence details', () => {
  it('writes finished jobs with the TTL and active ones without, and lists with filters and cursors', async () => {
    const sets: { key: string; ttlSec?: number; status?: string }[] = [];
    class RecordingKv extends MemoryKv {
      override async kvSet(key: string, value: unknown, opts: { ttlSec?: number } = {}): Promise<void> {
        sets.push({ key, ttlSec: opts.ttlSec, status: (value as { status?: string }).status });
        return super.kvSet(key, value, opts);
      }
    }
    const q = queueWith({ ctx: youtubeCtx({ env: { VID2CONTEXT_JOB_TTL_HOURS: '2' } }), kv: new RecordingKv() });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await q.enqueue('context', 'jNQXAC9IVRw')).id);
    const bad = await q.enqueue('context', 'https://vimeo.com/76979871');
    await q.idle();

    const finished = sets.filter((s) => s.status === 'succeeded' || s.status === 'failed');
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.every((s) => s.ttlSec === 7200)).toBe(true);
    expect(sets.filter((s) => s.status === 'queued' || s.status === 'running').every((s) => s.ttlSec === undefined)).toBe(true);

    const failed = await q.list({ status: 'failed' });
    expect(failed.jobs.map((j) => j.id)).toEqual([bad.id]);
    const page1 = await q.list({ limit: 2 });
    expect(page1.jobs).toHaveLength(2);
    expect(page1.cursor).toBeTruthy();
    const page2 = await q.list({ limit: 2, cursor: page1.cursor });
    expect(page2.jobs).toHaveLength(2);
    expect(page2.cursor).toBeUndefined();
    expect(new Set([...page1.jobs, ...page2.jobs].map((j) => j.id))).toEqual(new Set([...ids, bad.id]));
    await expect(q.list({ cursor: 'nonsense!' })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('reads concurrency and TTL from env and rejects bad values', () => {
    const q = queueWith({ ctx: youtubeCtx({ env: { VID2CONTEXT_JOB_CONCURRENCY: '5' } }), autoStart: false });
    expect(q.concurrency).toBe(5);
    expect(() =>
      createJobQueue({ registry: youtubeRegistry(), ctx: youtubeCtx({ env: { VID2CONTEXT_JOB_CONCURRENCY: 'many' } }) }),
    ).toThrow(/VID2CONTEXT_JOB_CONCURRENCY/);
  });
});
