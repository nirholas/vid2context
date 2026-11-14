import { readFileSync } from 'node:fs';
import { MemoryStorage, Registry, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import youtube from '@vid2context/provider-youtube';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { exporterRoutes } from '../src/http.ts';
import type { ObsidianFile } from '../src/obsidian.ts';

const fixture = (name: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${name}.json`, import.meta.url), 'utf8')) as VideoContext;

const zoo = fixture('youtube-jNQXAC9IVRw');
const gwagon = fixture('youtube-cCPsdFdlshc');

// A fetch with no recorded responses: every context below comes from storage, so any network call fails the test.
const fetch = replayFetch([]);
const storage = new MemoryStorage();
let collectionId = '';

/** Mounted the way packages/server mounts sub-apps, with the same error body. */
function app(env: Record<string, string> = {}): Hono {
  const root = new Hono();
  root.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    const status = e?.code === 'bad-request' ? 400 : e?.code === 'not-found' ? 404 : e?.code === 'no-provider' ? 503 : 500;
    return c.json({ error: { code: e?.code ?? 'internal', message: err.message, ...(e?.hint ? { hint: e.hint } : {}) } }, status);
  });
  root.route(
    '/api/v1',
    exporterRoutes({
      registry: new Registry(youtube, 'node'),
      makeCtx: () => testContext({ fetch, env }),
      storage: async () => storage,
    }),
  );
  return root;
}

const post = (a: Hono, path: string, body: unknown) =>
  a.request(`/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  await storage.putContext(zoo);
  await storage.putContext(gwagon);
  const c = await storage.createCollection({ name: 'G-Wagon buyer research' });
  collectionId = (await storage.addToCollection(c.id, [gwagon.metadata.ref.id, zoo.metadata.ref.id])).id;
});

describe('POST /exports/obsidian', () => {
  it('returns the vault files for a collection without writing anything', async () => {
    const res = await post(app(), '/exports/obsidian', { collectionId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: ObsidianFile[]; missing: string[] };
    expect(body.files.map((f) => f.path)).toEqual([
      'G-Wagon buyer research/Best & Worst G-Wagon Years - Reliability, Interiors & Engines Ranked!.md',
      'G-Wagon buyer research/Me at the zoo.md',
      'G-Wagon buyer research/G-Wagon buyer research.md',
    ]);
    expect(body.missing).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
  });

  it('accepts video inputs and a folder', async () => {
    const res = await post(app(), '/exports/obsidian', {
      inputs: ['https://www.youtube.com/watch?v=jNQXAC9IVRw'],
      folder: 'Videos',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: ObsidianFile[] };
    expect(body.files.map((f) => f.path)).toEqual(['Videos/Me at the zoo.md']);
    expect(body.files[0]?.content).toContain('vid2context-id: "youtube:jNQXAC9IVRw"');
    expect(fetch.calls).toHaveLength(0);
  });

  it('rejects empty and malformed requests with a hint', async () => {
    const empty = await post(app(), '/exports/obsidian', {});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: { code: 'bad-request', hint: expect.any(String) } });
    expect((await post(app(), '/exports/obsidian', { inputs: 'not-an-array' })).status).toBe(400);
    expect((await post(app(), '/exports/obsidian', { collectionId: 'nope' })).status).toBe(404);
    const notJson = await app().request('/api/v1/exports/obsidian', { method: 'POST', body: '{' });
    expect(notJson.status).toBe(400);
  });
});

describe('POST /exports/notion', () => {
  it('explains the missing token before touching any video or Notion', async () => {
    const res = await post(app(), '/exports/notion', { collectionId });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'no-provider', message: 'NOTION_TOKEN is not set.' } });
    expect(fetch.calls).toHaveLength(0);
  });

  it('asks for a parent page when none is configured', async () => {
    const res = await post(app({ NOTION_TOKEN: 'set' }), '/exports/notion', { collectionId });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'bad-request', hint: expect.stringContaining('NOTION_PARENT_PAGE_ID') },
    });
    expect(fetch.calls).toHaveLength(0);
  });
});
