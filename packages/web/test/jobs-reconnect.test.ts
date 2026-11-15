/**
 * followJob keeps following a job when its event stream drops or goes silent,
 * against the real jobs routes and queue from @vid2context/jobs. The job kind
 * here is a test workload (three progress steps behind gates); the SSE bytes,
 * ids, heartbeats and Last-Event-ID handling are the server's own.
 */
import { MemoryStorage, Registry, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { createJobQueue, type InProcessQueue } from '@vid2context/jobs';
import { jobsRoutes } from '@vid2context/jobs/http';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { followJob, type JobProgress, postJob } from '../src/lib/jobs.ts';

const BASE = 'http://v2c.test/api/v1';

let queue: InProcessQueue;
let app: Hono;
/** Gates the `steps` job waits on; release(n) lets step n finish. */
let gates: { promise: Promise<void>; release: () => void }[];
/** Every request the client sent, with its Last-Event-ID. */
let requests: { url: string; lastEventId: string | null }[];

function gate() {
  let release = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

beforeEach(() => {
  gates = [gate(), gate(), gate()];
  requests = [];
  const registry = new Registry([], 'node');
  queue = createJobQueue({ registry, ctx: testContext(), storage: new MemoryStorage() });
  queue.registerKind(
    'steps',
    async ({ progress }) => {
      for (let i = 0; i < gates.length; i++) {
        await gates[i]?.promise;
        progress({ done: i + 1, total: gates.length, message: `step ${i + 1}` });
      }
      return { steps: gates.length };
    },
    { maxAttempts: 1 },
  );
  app = new Hono();
  // As the server does: a Vid2ContextError becomes its status and the standard error body.
  app.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    return c.json(
      { error: { code: e?.code ?? 'internal', message: err.message }, attempts: [] },
      e?.code === 'not-found' ? 404 : e?.code === 'bad-request' ? 400 : 500,
    );
  });
  app.route(
    '/api/v1',
    jobsRoutes({
      registry,
      makeCtx: () => testContext(),
      storage: async () => queue.storage as MemoryStorage,
      queue,
      heartbeatMs: 20,
    }),
  );
});

afterEach(async () => {
  for (const g of gates) g.release();
  await queue.close();
});

/** The app as a fetch, recording requests; `shape` may rewrite a response the way a network fault would. */
function fetchVia(shape: (res: Response, n: number) => Response = (r) => r): typeof fetch {
  let n = 0;
  return async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.endsWith('/events')) requests.push({ url, lastEventId: headers.get('last-event-id') });
    const res = await app.request(url, init);
    return url.endsWith('/events') ? shape(res, n++) : res;
  };
}

/** Pass the body through until `after` events have gone by, then error it like a dropped connection. */
function dropAfter(res: Response, after: number): Response {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Error on the pull after the last chunk went out: erroring drops chunks still queued.
      if (seen >= after) {
        await reader.cancel();
        controller.error(new TypeError('network error'));
        return;
      }
      const { value, done } = await reader.read();
      if (done) return controller.close();
      controller.enqueue(value);
      seen += (decoder.decode(value).match(/^id: /gm) ?? []).length;
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}

/** The headers arrive, then nothing more: a socket a proxy holds open. */
function silent(res: Response): Response {
  void res.body?.cancel();
  return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
    status: res.status,
    headers: res.headers,
  });
}

const noWait = { retryDelayMs: () => 1 };

/** The error a promise rejects with; fails the test if it resolves. */
async function rejection(p: Promise<unknown>): Promise<Vid2ContextError> {
  try {
    await p;
  } catch (err) {
    return err as Vid2ContextError;
  }
  throw new Error('expected the promise to reject');
}

describe('followJob', () => {
  it('reconnects with Last-Event-ID after a dropped stream and sees every step once', async () => {
    const call = { base: BASE, fetch: fetchVia((res, n) => (n === 0 ? dropAfter(res, 2) : res)) };
    const job = await postJob('steps', 'x', {}, call);
    const seen: JobProgress[] = [];
    gates[0]?.release();
    const following = followJob(job.id, (p) => seen.push(p), call, noWait);
    // Let the rest run once the first connection is gone.
    await expect.poll(() => requests.length).toBeGreaterThan(1);
    gates[1]?.release();
    gates[2]?.release();
    await expect(following).resolves.toEqual({ steps: 3 });
    expect(requests[0]?.lastEventId).toBeNull();
    expect(Number(requests[1]?.lastEventId)).toBeGreaterThan(0);
    const steps = seen.map((p) => p.message).filter((m) => m?.startsWith('step '));
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps.at(-1)).toBe('step 3');
  });

  it('reconnects when the stream goes silent instead of waiting forever', async () => {
    const call = { base: BASE, fetch: fetchVia((res, n) => (n === 0 ? silent(res) : res)) };
    const job = await postJob('steps', 'x', {}, call);
    for (const g of gates) g.release();
    await expect(followJob(job.id, () => {}, call, { ...noWait, idleMs: 100 })).resolves.toEqual({ steps: 3 });
    expect(requests.length).toBe(2);
  });

  it('gives up with a timeout after the allowed reconnects all stay silent', async () => {
    const call = { base: BASE, fetch: fetchVia(silent) };
    const job = await postJob('steps', 'x', {}, call);
    const err = await rejection(followJob(job.id, () => {}, call, { ...noWait, idleMs: 50, maxReconnects: 2 }));
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err.code).toBe('timeout');
    expect(requests.length).toBe(3);
  });

  it('does not retry a job the server does not know', async () => {
    const call = { base: BASE, fetch: fetchVia() };
    const err = await rejection(followJob('no-such-job', () => {}, call, noWait));
    expect(err.code).toBe('not-found');
    expect(requests.length).toBe(1);
  });

  it('stops at once when the caller aborts', async () => {
    const controller = new AbortController();
    const call = { base: BASE, fetch: fetchVia(silent), signal: controller.signal };
    const job = await postJob('steps', 'x', {}, call);
    const following = rejection(followJob(job.id, () => {}, call, noWait));
    await expect.poll(() => requests.length).toBe(1);
    controller.abort();
    const err = await following;
    expect(err.name).toBe('AbortError');
    expect(requests.length).toBe(1);
  });
});
