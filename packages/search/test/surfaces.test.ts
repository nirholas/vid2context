/**
 * GET /search through searchRoutes on a bare Hono app, and search_transcript
 * through the MCP SDK in-memory transport. Keyword-only (no embed provider),
 * over the real shared contexts saved in a MemoryStorage. No network: the
 * YouTube source only resolves URLs to ids here (synchronous, offline).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MemoryStorage, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import youtube from '@vid2context/provider-youtube';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../src/engine.ts';
import { searchRoutes } from '../src/http.ts';
import { registerSearchTools } from '../src/mcp.ts';
import { GWAGON, loadContext, registryWith, ZOO } from './helpers.ts';

const gwagon = loadContext(GWAGON);
const zoo = loadContext(ZOO);

async function library() {
  const storage = new MemoryStorage();
  await storage.putContext(gwagon);
  await storage.putContext(zoo);
  return storage;
}

const registry = registryWith([youtube].flat());

function app(storage: MemoryStorage) {
  const sub = searchRoutes({ registry, makeCtx: () => testContext(), storage: async () => storage });
  const root = new Hono();
  // The same contract the main app's onError implements: standard body, status by code.
  root.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    const status = e?.code === 'bad-request' ? 400 : e?.code === 'not-found' ? 404 : 500;
    return c.json({ error: { code: e?.code ?? 'internal', message: err.message, hint: e?.hint }, attempts: [] }, status);
  });
  root.route('/api/v1', sub);
  return root;
}

describe('GET /search', () => {
  it('returns hits with timestamp urls and metadata', async () => {
    const res = await app(await library()).request('/api/v1/search?q=Land%20Cruiser%20killer&limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResult;
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits.length).toBeLessThanOrEqual(2);
    const [top] = body.hits;
    expect(top?.videoId).toBe('youtube:cCPsdFdlshc');
    expect(top?.text).toContain('Land Cruiser killer');
    expect(top?.url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=cCPsdFdlshc&t=\d+s$/);
    expect(body.meta.vector).toBe('disabled');
  });

  it('scopes by videoIds and collectionId', async () => {
    const storage = await library();
    const c = await storage.createCollection({ name: 'zoo' });
    await storage.addToCollection(c.id, ['youtube:jNQXAC9IVRw']);
    const a = app(storage);
    const byIds = (await (await a.request('/api/v1/search?q=cool&videoIds=youtube:jNQXAC9IVRw')).json()) as SearchResult;
    expect(new Set(byIds.hits.map((h) => h.videoId))).toEqual(new Set(['youtube:jNQXAC9IVRw']));
    const byCollection = (await (await a.request(`/api/v1/search?q=G550&collectionId=${c.id}`)).json()) as SearchResult;
    expect(byCollection.hits).toEqual([]);
    const missing = await a.request('/api/v1/search?q=G550&collectionId=nope');
    expect(missing.status).toBe(404);
  });

  it('rejects bad parameters with bad-request and a hint', async () => {
    const a = app(await library());
    for (const path of [
      '/api/v1/search',
      '/api/v1/search?q=x&limit=0',
      '/api/v1/search?q=x&mode=fuzzy',
      '/api/v1/search?q=x&origin=radio',
    ]) {
      const res = await a.request(path);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; hint?: string } };
      expect(body.error.code).toBe('bad-request');
      expect(body.error.hint).toBeTruthy();
    }
  });
});

describe('MCP search_transcript', () => {
  async function connect(storage: MemoryStorage) {
    const server = new McpServer({ name: 'search-test', version: '0.0.0' });
    registerSearchTools(server, { registry, ctx: testContext(), storage });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it('is listed and returns title, [m:ss], highlighted text and a timestamp url', async () => {
    const client = await connect(await library());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('search_transcript');
    const res = await client.callTool({ name: 'search_transcript', arguments: { query: 'timing chain', limit: 2 } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('1. Best & Worst G-Wagon Years');
    expect(text).toMatch(/\[\d+:\d\d-\d+:\d\d\]/);
    expect(text).toMatch(/https:\/\/www\.youtube\.com\/watch\?v=cCPsdFdlshc&t=\d+s/);
    expect(text).toContain('**timing**');
    expect(text).toContain('vector search disabled');
  });

  it('scopes to urls already in the library', async () => {
    const client = await connect(await library());
    const res = await client.callTool({
      name: 'search_transcript',
      arguments: { query: 'cool', urls: ['https://www.youtube.com/watch?v=jNQXAC9IVRw'] },
    });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Me at the zoo');
    expect(text).not.toContain('G-Wagon');
  });

  it('returns errors as isError tool results with the standard body', async () => {
    const client = await connect(await library());
    const res = await client.callTool({ name: 'search_transcript', arguments: { query: 'G550', collection: 'nope' } });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? '{}') as { error: string; hint?: string };
    expect(body.error).toBe('not-found');
    expect(body.hint).toBe('List collections to see valid ids.');
  });
});
