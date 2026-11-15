/**
 * The expensive-request cap, driven by the real app against a real local TCP
 * server that accepts connections and never answers: every upstream call of a
 * request hangs there until the request's own deadline ends it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testContext } from '@vid2context/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concurrencyConfig, isHeavy, RequestLimiter } from '../src/concurrency.ts';
import { makeApp } from './helpers.ts';

let server: Server;
let base = '';
const held = new Set<import('node:http').ServerResponse>();

beforeAll(async () => {
  server = createServer((_req, res) => {
    held.add(res);
    res.on('close', () => held.delete(res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const res of held) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** An app whose upstream fetches all go to the silent local server. */
function silentApp(env: Record<string, string>) {
  const hang: typeof fetch = (_input, init) => globalThis.fetch(`${base}/hang`, { signal: init?.signal ?? null });
  return makeApp({
    env: { VID2CONTEXT_REQUEST_TIMEOUT_MS: '1500', ...env },
    app: {
      makeCtx: (req) =>
        testContext({
          fetch: hang,
          env: { VID2CONTEXT_RATE_LIMIT: '0', VID2CONTEXT_REQUEST_TIMEOUT_MS: '1500', ...env },
          signal: req.signal,
        }),
    },
  }).app;
}

describe('expensive request cap', () => {
  it('runs the cap, queues the next request, and answers 503 busy with Retry-After past the queue', async () => {
    const app = silentApp({ VID2CONTEXT_MAX_CONCURRENT: '1', VID2CONTEXT_MAX_WAITING: '1', VID2CONTEXT_QUEUE_WAIT_MS: '10000' });
    const first = app.request('/api/v1/context?url=jNQXAC9IVRw');
    await new Promise((r) => setTimeout(r, 100));
    const second = app.request('/api/v1/context?url=cCPsdFdlshc');
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    const third = await app.request('/api/v1/transcript?url=Pqdv2ql971M');
    expect(Date.now() - started).toBeLessThan(500);
    expect(third.status).toBe(503);
    expect(third.headers.get('retry-after')).toBe('5');
    const body = (await third.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('busy');
    expect(body.error.hint).toContain('VID2CONTEXT_MAX_CONCURRENT');
    // Health is never limited.
    expect((await app.request('/api/v1/health')).status).toBe(200);
    // The first request hits its deadline, which frees the slot for the queued one (also a deadline, not busy).
    expect((await first).status).toBe(504);
    expect((await second).status).toBe(504);
  });

  it('answers busy when no slot comes free within VID2CONTEXT_QUEUE_WAIT_MS', async () => {
    const app = silentApp({ VID2CONTEXT_MAX_CONCURRENT: '1', VID2CONTEXT_QUEUE_WAIT_MS: '200' });
    const first = app.request('/api/v1/context?url=jNQXAC9IVRw');
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const second = await app.request('/api/v1/context?url=cCPsdFdlshc');
    expect(second.status).toBe(503);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
    expect(((await second.json()) as { error: { message: string } }).error.message).toContain('no slot came free');
    expect((await first).status).toBe(504);
  });

  it('drops a waiter whose client went away and hands the slot to the next one', async () => {
    const limiter = new RequestLimiter();
    const cfg = { maxConcurrent: 1, maxWaiting: 5, queueWaitMs: 10_000 };
    await limiter.acquire(cfg);
    const gone = new AbortController();
    const left = limiter.acquire(cfg, gone.signal);
    const next = limiter.acquire(cfg);
    gone.abort();
    await expect(left).rejects.toMatchObject({ name: 'AbortError' });
    limiter.release();
    await next;
    expect(limiter.running).toBe(1);
    expect(limiter.queued).toBe(0);
    limiter.release();
    expect(limiter.running).toBe(0);
  });

  it('limits only expensive routes, and reads its settings with safe defaults', () => {
    expect(isHeavy('GET', '/api/v1/context')).toBe(true);
    expect(isHeavy('POST', '/api/v1/uploads')).toBe(true);
    expect(isHeavy('POST', '/mcp')).toBe(true);
    expect(isHeavy('GET', '/mcp')).toBe(false);
    expect(isHeavy('GET', '/api/v1/health')).toBe(false);
    expect(isHeavy('GET', '/api/v1/jobs/job_x/events')).toBe(false);
    expect(isHeavy('OPTIONS', '/api/v1/context')).toBe(false);
    expect(concurrencyConfig({})).toEqual({ maxConcurrent: 16, maxWaiting: 64, queueWaitMs: 30_000 });
    expect(concurrencyConfig({ VID2CONTEXT_MAX_CONCURRENT: '0', VID2CONTEXT_MAX_WAITING: 'x' })).toMatchObject({
      maxConcurrent: 0,
      maxWaiting: 64,
    });
  });
});
