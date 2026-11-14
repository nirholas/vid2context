import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MemoryStorage, Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { dedupeRoutes } from '../src/http.ts';
import { registerDedupeTools } from '../src/mcp.ts';
import { loadFixture } from './helpers.ts';

const ORIGINAL = 'youtube:jNQXAC9IVRw';
const REUPLOADS = ['youtube:9Pd5fi1DCb8', 'youtube:g5RBHWskGtc'];

/** A library holding real recorded contexts. testContext's fetch rejects every call, so nothing reaches the network. */
async function library(): Promise<{ storage: Storage; collectionId: string }> {
  const storage = new MemoryStorage();
  const contexts = [
    loadFixture('youtube-jNQXAC9IVRw.json', 'shared'),
    loadFixture('youtube-9Pd5fi1DCb8.json'),
    loadFixture('youtube-g5RBHWskGtc.json'),
    loadFixture('youtube-cCPsdFdlshc.json', 'shared'),
  ];
  for (const c of contexts) await storage.putContext(c);
  const collection = await storage.createCollection({ name: 'zoo' });
  await storage.addToCollection(
    collection.id,
    contexts.map((c) => c.metadata.ref.id),
  );
  return { storage, collectionId: collection.id };
}

// No source providers: collections need none, and URL inputs fail as unsupported (the live test below uses the real registry).
const registry = new Registry([], 'node');

function app(storage: Storage): Hono {
  const main = new Hono();
  main.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    return c.json({ error: { code: e?.code ?? 'internal', message: err.message, hint: e?.hint } }, e ? 400 : 500);
  });
  main.route('/api/v1', dedupeRoutes({ registry, makeCtx: () => testContext(), storage: async () => storage }));
  return main;
}

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /duplicates', () => {
  it('groups a saved collection by its real transcripts', async () => {
    const { storage, collectionId } = await library();
    const res = await app(storage).request('/api/v1/duplicates', post({ collectionId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].kind).toBe('reupload');
    expect(body.groups[0].original).toBe(ORIGINAL);
    expect(body.representativeOf['youtube:cCPsdFdlshc']).toBe('youtube:cCPsdFdlshc');
    expect(body.videos[ORIGINAL].title).toBe('Me at the zoo');
    expect(body.failed).toEqual([]);
  });

  it('reports inputs it cannot load and still compares the rest', async () => {
    const { storage } = await library();
    const res = await app(storage).request('/api/v1/duplicates', post({ inputs: ['not a video'] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failed).toEqual([{ input: 'not a video', code: 'unsupported-input', message: expect.any(String) }]);
    expect(body.groups).toEqual([]);
    expect(body.stats.videos).toBe(0);
  });

  it('rejects empty and malformed requests with a hint', async () => {
    const { storage } = await library();
    for (const body of [{}, { inputs: 'x' }, { collectionId: 5 }, { inputs: ['x'], options: { clipOverlap: 2 } }]) {
      const res = await app(storage).request('/api/v1/duplicates', post(body));
      const json = await res.json();
      expect(json.error.code).toBe('bad-request');
      expect(json.error.hint).toBeTruthy();
    }
    const res = await app(storage).request('/api/v1/duplicates', post({ collectionId: 'missing' }));
    expect((await res.json()).error.code).toBe('not-found');
  });
});

describe('find_duplicates MCP tool', () => {
  async function connect(storage: Storage | null): Promise<Client> {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerDedupeTools(server, { registry, ctx: testContext(), storage });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(b);
    return client;
  }

  it('returns groups with evidence for a collection', async () => {
    const { storage, collectionId } = await library();
    const client = await connect(storage);
    const result = await client.callTool({ name: 'find_duplicates', arguments: { collection: collectionId } });
    expect(result.isError).toBeFalsy();
    const report = JSON.parse((result.content as { text: string }[])[0]?.text ?? '');
    expect(report.groups[0].kind).toBe('reupload');
    expect(report.groups[0].evidence.overlap).toBeGreaterThan(0.8);
    expect(report.representativeOf[REUPLOADS[0] as string]).toBe(ORIGINAL);
  });

  it('answers a tool error, not a protocol error, when there is no library', async () => {
    const client = await connect(null);
    const result = await client.callTool({ name: 'find_duplicates', arguments: { collection: 'zoo' } });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as { text: string }[])[0]?.text ?? '');
    expect(payload.error).toBe('bad-request');
    expect(payload.hint).toBeTruthy();
  });
});

describe.skipIf(!process.env.LIVE)('POST /duplicates live', () => {
  it('fetches real videos by URL and finds the reupload', async () => {
    const { createNodeRegistry } = await import('@vid2context/registry');
    const { createContext, stderrLogger } = await import('@vid2context/core');
    const live = createNodeRegistry();
    const main = new Hono();
    main.route(
      '/api/v1',
      dedupeRoutes({
        registry: live,
        makeCtx: () => createContext({ runtime: 'node', env: {}, fetch: globalThis.fetch, log: stderrLogger('warn') }),
        storage: async () => new MemoryStorage(),
      }),
    );
    const inputs = ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/watch?v=g5RBHWskGtc'];
    const res = await main.request('/api/v1/duplicates', post({ inputs }));
    const body = await res.json();
    expect(body.failed).toEqual([]);
    expect(body.groups[0]?.kind).toBe('reupload');
  });
});
