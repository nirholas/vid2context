import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { MemoryStorage } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { resetBreaker } from '@vid2context/provider-youtube';
import { createApp } from '@vid2context/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobsRoutes } from '../src/http.ts';
import { createJobQueue, type InProcessQueue, registerBuiltinKinds } from '../src/index.ts';
import { PLAYLIST, PLAYLIST_FIRST3, waitFor, youtubeCtx, youtubeRegistry } from './helpers.ts';

interface SseEvent {
  id?: number;
  event?: string;
  data?: unknown;
}

/** Read an SSE response with a real stream reader. Stops when `stop` returns true or the stream ends. */
async function readEvents(
  res: Response,
  stop: (e: SseEvent, all: SseEvent[]) => boolean = () => false,
): Promise<{ events: SseEvent[]; comments: string[] }> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  const comments: string[] = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const e: SseEvent = {};
      let isEvent = false;
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) comments.push(line.slice(1).trim());
        else if (line.startsWith('id: ')) {
          e.id = Number(line.slice(4));
          isEvent = true;
        } else if (line.startsWith('event: ')) e.event = line.slice(7);
        else if (line.startsWith('data: ')) e.data = JSON.parse(line.slice(6));
      }
      if (isEvent) {
        events.push(e);
        if (stop(e, events)) {
          await reader.cancel();
          return { events, comments };
        }
      }
      idx = buf.indexOf('\n\n');
    }
  }
  return { events, comments };
}

describe('jobs HTTP routes and SSE', () => {
  let base = '';
  let server: ReturnType<typeof serve>;
  let queue: InProcessQueue;
  // Each player request waits here, so the test can disconnect mid-job.
  const waiting: (() => void)[] = [];
  let hold = true;

  beforeAll(async () => {
    queue = createJobQueue({
      registry: youtubeRegistry(),
      ctx: youtubeCtx({
        beforePlayer: () => (hold ? new Promise<void>((r) => waiting.push(r)) : undefined),
      }),
      storage: new MemoryStorage(),
    });
    registerBuiltinKinds(queue);
    const app = createApp({ registry: youtubeRegistry(), makeCtx: () => testContext({ env: { VID2CONTEXT_ACCESS_LOG: '0' } }) });
    app.route(
      '/api/v1',
      jobsRoutes({
        registry: youtubeRegistry(),
        makeCtx: () => testContext(),
        storage: async () => queue.storage,
        queue,
        heartbeatMs: 50,
      }),
    );
    const port = 20000 + Math.floor(Math.random() * 10000);
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterAll(async () => {
    hold = false;
    for (const release of waiting.splice(0)) release();
    await queue.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('streams an items job, and a reconnect with Last-Event-ID resumes without duplicates', async () => {
    const post = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'items', input: PLAYLIST, options: { limit: 3, concurrency: 1 } }),
    });
    expect(post.status).toBe(202);
    const job = (await post.json()) as { id: string; status: string; kind: string };
    expect(job).toMatchObject({ kind: 'items', status: 'queued' });

    // Let the first video through, then disconnect after its item event.
    await waitFor(() => waiting.length > 0);
    const first = await fetch(`${base}/jobs/${job.id}/events`);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    (waiting.shift() as () => void)();
    const part1 = await readEvents(first, (e) => e.event === 'item');
    const lastId = part1.events.at(-1)?.id as number;
    expect(part1.events.at(-1)?.data).toMatchObject({ id: 'youtube:jNQXAC9IVRw', outcome: 'ok' });

    // While disconnected, the rest of the job runs to the end.
    hold = false;
    for (const release of waiting.splice(0)) release();
    await waitFor(async () => ((await queue.get(job.id))?.status ?? '') === 'succeeded');

    const second = await fetch(`${base}/jobs/${job.id}/events`, { headers: { 'last-event-id': String(lastId) } });
    const part2 = await readEvents(second);
    const all = [...part1.events, ...part2.events];
    const ids = all.map((e) => e.id as number);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(part2.events.every((e) => (e.id as number) > lastId)).toBe(true);
    expect(all.filter((e) => e.event === 'item').map((e) => (e.data as { id: string }).id)).toEqual(PLAYLIST_FIRST3);
    const end = all.at(-1);
    expect(end?.event).toBe('done');
    expect(end?.data).toMatchObject({ result: { succeeded: 1, failed: 2 } });

    // A fresh connection to a finished job replays the state and closes.
    const replay = await readEvents(await fetch(`${base}/jobs/${job.id}/events`));
    expect(replay.events.filter((e) => e.event === 'item')).toHaveLength(3);
    expect(replay.events.at(-1)?.event).toBe('done');

    const got = await fetch(`${base}/jobs/${job.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id: job.id, status: 'succeeded', progress: { done: 3, total: 3 } });
  });

  it('sends heartbeats while a job is waiting, and DELETE cancels it with 202', async () => {
    // The previous test's recorded 429 opened the provider's circuit breaker.
    resetBreaker();
    hold = true;
    const post = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'context', input: 'cCPsdFdlshc' }),
    });
    const job = (await post.json()) as { id: string };
    await waitFor(() => waiting.length > 0);
    const res = await fetch(`${base}/jobs/${job.id}/events`);
    const reading = readEvents(res);
    await new Promise((r) => setTimeout(r, 130));
    const del = await fetch(`${base}/jobs/${job.id}`, { method: 'DELETE' });
    expect(del.status).toBe(202);
    expect(await del.json()).toMatchObject({ id: job.id, status: 'canceled', error: { code: 'canceled' } });
    const { events, comments } = await reading;
    expect(comments.filter((c) => c === 'heartbeat').length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.event).toBe('progress');
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'canceled' } });
    hold = false;
    for (const release of waiting.splice(0)) release();
  });

  it('answers errors with the standard body', async () => {
    const unknown = await fetch(`${base}/jobs/job_AAAAAAAAAAAAAAAAAAAAAA`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'not-found' } });

    const events404 = await fetch(`${base}/jobs/job_AAAAAAAAAAAAAAAAAAAAAA/events`);
    expect(events404.status).toBe(404);

    const badKind = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'nope', input: 'x' }),
    });
    expect(badKind.status).toBe(400);
    expect(await badKind.json()).toMatchObject({
      error: { code: 'bad-request', hint: 'Registered kinds: bundle, context, items.' },
    });

    const badJson = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(badJson.status).toBe(400);

    const noRun = await fetch(`${base}/jobs/job_AAAAAAAAAAAAAAAAAAAAAA/run`, { method: 'POST' });
    expect(noRun.status).toBe(404);
  });
});
