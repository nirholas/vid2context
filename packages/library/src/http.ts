/**
 * Collection routes as a Hono sub-app. Item 46 (or the integration pass)
 * mounts it: `app.route('/api/v1', libraryRoutes(deps))`.
 *
 *   GET    /collections                 { collections }
 *   POST   /collections                 { name, description?, sources?, watch? } -> 201 Collection
 *   GET    /collections/:id             Collection & { videos, pending, watch }
 *   PATCH  /collections/:id             { name?, description?, sources?, watch? } -> Collection
 *   DELETE /collections/:id             204
 *   POST   /collections/:id/items       { inputs, limit? } -> 202 Job (kind ingest), or { collection, summary } without a queue
 *   DELETE /collections/:id/items       { videoIds } -> Collection
 *   POST   /collections/:id/refresh     { limit? } -> 202 Job (kind refresh), or { collection, summary } without a queue
 *   GET    /collections/:id/export      CollectionDefinition
 *   POST   /collections/import          CollectionDefinition (?refresh=1 ingests now) -> 201 { collection, summary? }
 *
 * With a jobs queue (deps.jobs), ingest and refresh run as jobs whose result
 * is `{ collection, summary }`; without one they run inline and answer that
 * directly.
 *
 * Errors are thrown as Vid2ContextError and handled by the main app's
 * onError, so they get the standard body and status.
 */
import { type Ctx, hasKv, type KvStore, MemoryKv, type Registry, type Storage } from '@vid2context/core';
import type { JobQueue } from '@vid2context/jobs';
import { type Context, Hono } from 'hono';
import { INGEST_KIND, REFRESH_KIND, registerLibraryJobs } from './jobs.ts';
import { createLibrary, type Library, type LibraryDeps } from './library.ts';
import { bad } from './util.ts';

export interface RouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  storage: (ctx: Ctx) => Promise<Storage>;
  /** Watch lists and seen sets, or a factory per request. Default: the storage when it implements KvStore, else one process-wide MemoryKv. */
  kv?: KvStore | ((ctx: Ctx) => Promise<KvStore>);
  /** Extra library options (webhook retries, lease TTL, clock). */
  library?: Pick<LibraryDeps, 'webhook' | 'leaseTtlSec' | 'now'>;
  /**
   * The jobs queue (@vid2context/jobs). When given, ingest and refresh answer
   * `202 Job` and run in the background (kinds `ingest` and `refresh`, which
   * this factory registers if the queue lacks them). Without it they run
   * inline and answer `{ collection, summary }`.
   */
  jobs?: Pick<JobQueue, 'enqueue' | 'kinds' | 'registerKind'>;
}

async function readBody(req: Request, example: string, optional = false): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) {
    if (optional) return {};
    throw bad('The request needs a JSON body.', `Send ${example} with Content-Type: application/json.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw bad('The body must be JSON.', `Send ${example} with Content-Type: application/json.`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The body must be a JSON object.', `Send ${example}.`);
  return body as Record<string, unknown>;
}

function optionalLimit(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    throw bad('limit must be a positive whole number.', 'Send {"limit": 20}, or leave it out.');
  return v;
}

/** On Workers, keep the isolate alive until webhooks are delivered; elsewhere the promise just runs. */
function keepAlive(c: Context, p: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // No ExecutionContext outside Workers.
  }
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

export function libraryRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  const fallbackKv = new MemoryKv();

  const kvFor = async (ctx: Ctx, storage: Storage): Promise<KvStore> =>
    typeof deps.kv === 'function' ? deps.kv(ctx) : (deps.kv ?? (hasKv(storage) ? storage : fallbackKv));
  const open = async (req: Request): Promise<Library> => {
    const ctx = deps.makeCtx(req);
    const storage = await deps.storage(ctx);
    return createLibrary({ registry: deps.registry, storage, ctx, kv: await kvFor(ctx, storage), ...deps.library });
  };
  const jobs = deps.jobs;
  if (jobs && !(jobs.kinds().includes(INGEST_KIND) && jobs.kinds().includes(REFRESH_KIND))) {
    registerLibraryJobs(jobs, { kv: kvFor, library: deps.library });
  }

  app.get('/collections', async (c) => {
    const lib = await open(c.req.raw);
    return c.json({ collections: await lib.listCollections() });
  });

  app.post('/collections/import', async (c) => {
    const lib = await open(c.req.raw);
    const body = await readBody(c.req.raw, '{"name": "...", "sources": [...], "videos": [...]}');
    const result = await lib.importCollection(body, { refresh: truthy(c.req.query('refresh')) });
    return c.json(result, 201);
  });

  app.post('/collections', async (c) => {
    const lib = await open(c.req.raw);
    const body = await readBody(c.req.raw, '{"name": "G-Wagon", "sources": ["<playlist URL>"]}');
    const collection = await lib.createCollection(body);
    if (body.watch !== undefined && body.watch !== null) {
      try {
        await lib.setWatch(collection.id, body.watch);
      } catch (err) {
        await lib.deleteCollection(collection.id);
        throw err;
      }
    }
    return c.json(collection, 201);
  });

  app.get('/collections/:id', async (c) => {
    const lib = await open(c.req.raw);
    return c.json(await lib.getCollectionDetail(c.req.param('id')));
  });

  app.patch('/collections/:id', async (c) => {
    const lib = await open(c.req.raw);
    const id = c.req.param('id');
    const body = await readBody(c.req.raw, '{"name"?: "...", "description"?: "...", "sources"?: [...], "watch"?: {...} | null}');
    if (body.watch === null) await lib.removeWatch(id);
    else if (body.watch !== undefined) await lib.setWatch(id, body.watch);
    return c.json(await lib.updateCollection(id, body));
  });

  app.delete('/collections/:id', async (c) => {
    const lib = await open(c.req.raw);
    const id = c.req.param('id');
    await lib.getCollection(id);
    await lib.deleteCollection(id);
    return c.body(null, 204);
  });

  app.post('/collections/:id/items', async (c) => {
    const lib = await open(c.req.raw);
    const id = c.req.param('id');
    const body = await readBody(c.req.raw, '{"inputs": ["<video or playlist URL>"]}');
    if (!Array.isArray(body.inputs) || body.inputs.length === 0 || body.inputs.some((x) => typeof x !== 'string' || !x.trim()))
      throw bad('inputs must be a non-empty array of strings.', 'Send {"inputs": ["<video or playlist URL>"]}.');
    const inputs = body.inputs as string[];
    const limit = optionalLimit(body.limit);
    if (jobs) {
      await lib.getCollection(id);
      return c.json(await jobs.enqueue(INGEST_KIND, { collectionId: id, inputs, ...(limit ? { limit } : {}) }), 202);
    }
    const summary = await lib.addVideos(id, inputs, { limit });
    return c.json({ collection: await lib.getCollection(id), summary });
  });

  app.delete('/collections/:id/items', async (c) => {
    const lib = await open(c.req.raw);
    const id = c.req.param('id');
    const body = await readBody(c.req.raw, '{"videoIds": ["youtube:cCPsdFdlshc"]}');
    if (!Array.isArray(body.videoIds)) throw bad('videoIds must be an array of strings.', 'Send {"videoIds": ["youtube:..."]}.');
    await lib.getCollection(id);
    return c.json(await lib.removeVideos(id, body.videoIds as string[]));
  });

  app.post('/collections/:id/refresh', async (c) => {
    const lib = await open(c.req.raw);
    const id = c.req.param('id');
    const body = await readBody(c.req.raw, '{"limit"?: 20}', true);
    const limit = optionalLimit(body.limit);
    if (jobs) {
      await lib.getCollection(id);
      return c.json(await jobs.enqueue(REFRESH_KIND, { collectionId: id, ...(limit ? { limit } : {}) }), 202);
    }
    const summary = await lib.refresh(id, { limit });
    keepAlive(c, lib.flush());
    return c.json({ collection: await lib.getCollection(id), summary });
  });

  app.get('/collections/:id/export', async (c) => {
    const lib = await open(c.req.raw);
    const def = await lib.exportCollection(c.req.param('id'));
    return c.json(def);
  });

  return app;
}
