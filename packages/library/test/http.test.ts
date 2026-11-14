import { attemptsOf, type Collection, MemoryKv, MemoryStorage, Vid2ContextError } from '@vid2context/core';
import { createJobQueue, type JobEventRecord } from '@vid2context/jobs';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { libraryRoutes } from '../src/http.ts';
import type { CollectionDefinition, CollectionDetail, RefreshSummary } from '../src/index.ts';
import { GWAGON, PLAYLIST, setup, ZOO } from './helpers.ts';

/** The sub-app mounted the way item 46 mounts it, with the contract's error body and statuses. */
function app() {
  const { registry, ctx, kv } = setup();
  const storage = new MemoryStorage();
  const api = new Hono();
  api.route('/api/v1', libraryRoutes({ registry, makeCtx: () => ctx, storage: async () => storage, kv }));
  api.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    const status = e?.code === 'not-found' ? 404 : e?.code === 'bad-request' || e?.code === 'unsupported-input' ? 400 : 500;
    return c.json(
      { error: { code: e?.code ?? 'internal', message: err.message, hint: e?.hint }, attempts: attemptsOf(err) },
      status,
    );
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.request(`/api/v1${path}`, {
      method,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      headers: { 'content-type': 'application/json' },
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { call, storage };
}

describe('collection routes', () => {
  it('create, list, get, patch, ingest, refresh, remove items and delete', async () => {
    const { call } = app();
    const created = await call('POST', '/collections', { name: 'G-Wagon', sources: [PLAYLIST] });
    expect(created.status).toBe(201);
    const c = created.json as Collection;
    expect(c).toEqual(expect.objectContaining({ name: 'G-Wagon', sources: [PLAYLIST], videoIds: [] }));

    const list = await call('GET', '/collections');
    expect(list.json.collections.map((x: Collection) => x.id)).toEqual([c.id]);

    const items = await call('POST', `/collections/${c.id}/items`, { inputs: ['jNQXAC9IVRw'] });
    expect(items.status).toBe(200);
    expect(items.json.summary.added.map((a: { id: string }) => a.id)).toEqual([ZOO]);
    expect(items.json.collection.videoIds).toEqual([ZOO]);

    const refreshed = await call('POST', `/collections/${c.id}/refresh`);
    const summary = refreshed.json.summary as RefreshSummary;
    expect(refreshed.status).toBe(200);
    expect(summary.added.map((a) => a.id)).toEqual([GWAGON]);
    expect(summary.failed.length).toBe(8);
    expect(refreshed.json.collection.videoIds).toEqual([ZOO, GWAGON]);

    const patched = await call('PATCH', `/collections/${c.id}`, {
      name: 'G-Wagon research',
      watch: { every: 'daily', at: '06:00' },
    });
    expect(patched.json.name).toBe('G-Wagon research');

    const detail = (await call('GET', `/collections/${c.id}`)).json as CollectionDetail;
    expect(detail.videos.map((v) => v.title)).toEqual(['Me at the zoo', expect.stringMatching(/G-Wagon Years/)]);
    expect(detail.watch?.schedule).toEqual({ every: 'daily', at: '06:00', enabled: true });

    await call('PATCH', `/collections/${c.id}`, { watch: null });
    expect((await call('GET', `/collections/${c.id}`)).json.watch).toBeNull();

    const removed = await call('DELETE', `/collections/${c.id}/items`, { videoIds: [ZOO] });
    expect(removed.json.videoIds).toEqual([GWAGON]);

    expect((await call('DELETE', `/collections/${c.id}`)).status).toBe(204);
    expect((await call('GET', `/collections/${c.id}`)).status).toBe(404);
    expect((await call('DELETE', `/collections/${c.id}`)).status).toBe(404);
  });

  it('exports and imports a definition', async () => {
    const { call } = app();
    const c = (await call('POST', '/collections', { name: 'G-Wagon', sources: [PLAYLIST], watch: { every: 'weekly' } }))
      .json as Collection;
    await call('POST', `/collections/${c.id}/items`, { inputs: ['jNQXAC9IVRw'] });
    const def = (await call('GET', `/collections/${c.id}/export`)).json as CollectionDefinition;
    expect(def).toEqual(
      expect.objectContaining({
        name: 'G-Wagon',
        sources: [PLAYLIST],
        videos: ['https://www.youtube.com/watch?v=jNQXAC9IVRw'],
        schedule: { every: 'weekly', enabled: true },
      }),
    );
    const imported = await call('POST', '/collections/import?refresh=1', { ...def, name: 'Copy' });
    expect(imported.status).toBe(201);
    expect(imported.json.collection.name).toBe('Copy');
    expect(imported.json.summary.added.map((a: { id: string }) => a.id).sort()).toEqual([GWAGON, ZOO].sort());
  });

  it('answers bad input with bad-request and a hint, and unknown ids with not-found', async () => {
    const { call, storage } = app();
    for (const [method, path, body] of [
      ['POST', '/collections', 'not json'],
      ['POST', '/collections', {}],
      ['POST', '/collections', { name: 'x', sources: ['https://www.youtube.com/watch?v=cCPsdFdlshc'] }],
      ['POST', '/collections', { name: 'x', watch: { every: 'sometimes' } }],
      ['POST', '/collections/import', { sources: [] }],
    ] as const) {
      const r = await call(method, path, body);
      expect(r.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
      expect(r.json.error.code).toBe('bad-request');
      expect(r.json.error.hint).toBeTruthy();
    }
    // A rejected watch list does not leave a half-created collection behind.
    expect(await storage.listCollections()).toEqual([]);

    const c = (await call('POST', '/collections', { name: 'x' })).json as Collection;
    const halfBad = await call('PATCH', `/collections/${c.id}`, { name: 'renamed', watch: { every: 'never' } });
    expect(halfBad.status).toBe(400);
    expect((await call('GET', `/collections/${c.id}`)).json.name).toBe('x');
    expect((await call('POST', `/collections/${c.id}/items`, { inputs: 'nope' })).status).toBe(400);
    expect((await call('POST', `/collections/${c.id}/items`)).status).toBe(400);
    expect((await call('POST', `/collections/${c.id}/refresh`, { limit: 0 })).status).toBe(400);
    expect((await call('POST', '/collections/missing/refresh')).status).toBe(404);
    expect((await call('GET', '/collections/missing/export')).status).toBe(404);
    expect((await call('PATCH', '/collections/missing', { name: 'y' })).status).toBe(404);
  });
});

describe('collection routes with the jobs queue', () => {
  it('queues ingest and refresh as 202 jobs that stream progress and items and finish with the summary', async () => {
    const { registry, ctx, kv } = setup();
    const storage = new MemoryStorage();
    const queue = createJobQueue({ registry, ctx, storage, kv: new MemoryKv() });
    const api = new Hono();
    api.route('/api/v1', libraryRoutes({ registry, makeCtx: () => ctx, storage: async () => storage, kv, jobs: queue }));
    const post = async (path: string, body?: unknown) => {
      const res = await api.request(`/api/v1${path}`, {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { 'content-type': 'application/json' },
      });
      return { status: res.status, json: await res.json() };
    };
    expect(queue.kinds()).toEqual(expect.arrayContaining(['ingest', 'refresh']));

    const c = (await post('/collections', { name: 'G-Wagon', sources: [PLAYLIST] })).json as Collection;
    const queued = await post(`/collections/${c.id}/items`, { inputs: ['jNQXAC9IVRw'] });
    expect(queued.status).toBe(202);
    expect(queued.json).toEqual(expect.objectContaining({ kind: 'ingest', status: expect.stringMatching(/queued|running/) }));

    const refresh = await post(`/collections/${c.id}/refresh`);
    expect(refresh.status).toBe(202);
    expect(refresh.json.kind).toBe('refresh');
    const events: JobEventRecord[] = [];
    queue.subscribe(refresh.json.id, (e) => events.push(e));
    await queue.idle();

    const ingestJob = await queue.get(queued.json.id);
    expect(ingestJob?.status).toBe('succeeded');
    expect((ingestJob?.result as { summary: RefreshSummary } | undefined)?.summary.added.map((a) => a.id)).toEqual([ZOO]);

    const refreshJob = await queue.get(refresh.json.id);
    expect(refreshJob?.status).toBe('succeeded');
    const result = refreshJob?.result as { collection: Collection; summary: RefreshSummary };
    expect(result.summary.added.map((a) => a.id)).toEqual([GWAGON]);
    expect(result.collection.videoIds).toEqual([ZOO, GWAGON]);
    expect(refreshJob?.progress).toEqual(expect.objectContaining({ done: 9, total: 9 }));
    const items = events.filter((e) => e.type === 'item').map((e) => e.data as { id: string; outcome: string });
    expect(items).toContainEqual(expect.objectContaining({ id: GWAGON, outcome: 'ok' }));
    expect(items.filter((i) => i.outcome === 'error')).toHaveLength(8);

    // Unknown collections fail before anything is queued.
    const before = (await queue.list()).jobs.length;
    const missing = await api.request('/api/v1/collections/missing/refresh', { method: 'POST' });
    expect(missing.status).toBe(500);
    expect((await queue.list()).jobs.length).toBe(before);
    await queue.close();
  });
});
