/**
 * insightsRoutes on a bare Hono app and registerInsightsTools on a real
 * McpServer (SDK in-memory transport). Videos come from a MemoryStorage
 * holding real fixtures (cache hits, no network); LLM answers are replayed
 * from recordings made LIVE with scripts/record-llm.ts.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clearCooldowns, MemoryStorage, Registry, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { createJobQueue } from '@vid2context/jobs';
import llm from '@vid2context/provider-llm-openai-compatible';
import youtube from '@vid2context/provider-youtube';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insightsRoutes } from '../src/http.ts';
import { registerInsightsTools } from '../src/mcp.ts';
import type { ExtractionResult } from '../src/types.ts';
import { GWAGON_IDS, gwagonContext, loadRecording, replayRecording } from './recording.ts';
import { SCENARIOS } from './scenarios.ts';

const registry = new Registry([...youtube, llm], 'node');
const url = (i: number) => `https://www.youtube.com/watch?v=${GWAGON_IDS[i]}`;

async function storageWith(indexes: number[]): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  for (const i of indexes) await storage.putContext(gwagonContext(i));
  return storage;
}

/** A bare app with the main server's error mapping, as item 46 mounts sub-apps. */
function mount(sub: Hono): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    const status = e?.code === 'bad-request' ? 400 : e?.code === 'not-found' ? 404 : 500;
    return c.json({ error: { code: e?.code ?? 'internal', message: err.message, hint: e?.hint } }, status);
  });
  app.route('/api/v1', sub);
  return app;
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(`/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  clearCooldowns();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => vi.useRealTimers());

const repair = SCENARIOS['extract-repair'];

describe('insightsRoutes', () => {
  it('answers POST /extract synchronously without a queue, with verified citations', async () => {
    const storage = await storageWith([0]);
    const fetch = replayRecording(loadRecording('extract-repair'));
    const app = mount(
      insightsRoutes({ registry, makeCtx: () => testContext({ fetch }), storage: async () => storage }),
    );
    const res = await post(app, '/extract', { inputs: [url(0)], schema: repair.options.schema, question: repair.options.question });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExtractionResult;
    expect(body.citations.length).toBeGreaterThan(0);
    for (const c of body.citations) expect(c.url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=cCPsdFdlshc&t=\d+s$/);
    expect(fetch.remaining()).toBe(0);
  });

  it('rejects bad bodies with 400 before doing any work', async () => {
    const app = mount(insightsRoutes({ registry, makeCtx: () => testContext() }));
    const cases: [string, unknown, string][] = [
      ['/briefs', {}, 'Nothing to read'],
      ['/briefs', { inputs: [url(0)], template: 'horoscope' }, 'Unknown template'],
      ['/extract', { inputs: [url(0)], template: 'summary', schema: { type: 'object' } }, 'not both'],
      ['/extract', { inputs: [url(0)], schema: { anyOf: [] } }, 'not supported'],
    ];
    for (const [path, body, message] of cases) {
      const res = await post(app, path, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(message);
    }
  });

  it('answers 202 Job through a @vid2context/jobs queue and registers the brief and extract kinds', async () => {
    const queue = createJobQueue({ registry, ctx: testContext(), storage: new MemoryStorage(), start: false });
    const app = mount(insightsRoutes({ registry, makeCtx: () => testContext(), queue }));
    expect(queue.kinds()).toEqual(expect.arrayContaining(['brief', 'extract']));
    const res = await post(app, '/briefs', { inputs: [url(0)], question: 'Which year?' });
    expect(res.status).toBe(202);
    const job = (await res.json()) as { id: string; kind: string; status: string };
    expect(job).toMatchObject({ kind: 'brief', status: 'queued' });
    await queue.close();
  });
});

describe('registerInsightsTools', () => {
  async function connect(fetch: typeof globalThis.fetch, storage: MemoryStorage) {
    const server = new McpServer({ name: 'insights-test', version: '0.0.0' });
    registerInsightsTools(server, { registry, ctx: testContext({ fetch }), storage });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it('registers build_brief and extract, and extract returns verified JSON', async () => {
    const fetch = replayRecording(loadRecording('extract-repair'));
    const client = await connect(fetch, await storageWith([0]));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['build_brief', 'extract']));
    const res = await client.callTool({
      name: 'extract',
      arguments: { urls: [url(0)], schema: repair.options.schema, question: repair.options.question },
    });
    expect(res.isError).toBeFalsy();
    const result = JSON.parse((res.content as { text: string }[])[0]?.text ?? '{}') as ExtractionResult;
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('returns errors as isError tool results with code and hint', async () => {
    const client = await connect(testContext().fetch, new MemoryStorage());
    const res = await client.callTool({ name: 'build_brief', arguments: {} });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? '{}') as { error: string; hint: string };
    expect(body.error).toBe('bad-request');
    expect(body.hint).toContain('inputs');
  });
});
