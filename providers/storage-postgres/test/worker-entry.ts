/**
 * A Cloudflare Worker that drives the provider end to end, bundled by
 * test/live.test.ts and run in workerd through Miniflare (no nodejs_compat).
 * It reads the Worker's env like the real Workers registry does, opens the
 * storage with runtime 'workers' (so the Neon HTTP driver is chosen) and
 * exercises contexts, search, collections, KV and vectors.
 */
import { createContext, type Env, type VideoContext } from '@vid2context/core';
// Imported by package name so the bundler applies the Workers export condition.
import provider from '@vid2context/provider-storage-postgres';

export default {
  async fetch(request: Request, workerEnv: Record<string, unknown>): Promise<Response> {
    const env: Env = {};
    for (const [k, v] of Object.entries(workerEnv)) if (typeof v === 'string') env[k] = v;
    const ctx = createContext({ runtime: 'workers', env, log: { debug() {}, info() {}, warn() {}, error() {} } });
    try {
      if (!provider.isEnabled(env)) return Response.json({ error: 'not enabled' }, { status: 500 });
      const context = (await request.json()) as VideoContext;
      const storage = (await provider.create(ctx)) as Awaited<ReturnType<typeof provider.create>> & {
        kvSet(k: string, v: unknown): Promise<void>;
        kvGet(k: string): Promise<unknown>;
        upsertVectors(r: unknown[]): Promise<void>;
        queryVectors(q: unknown): Promise<{ id: string; score: number }[]>;
      };
      await storage.putContext(context);
      const back = await storage.getContext(context.metadata.ref.id);
      const hits = await storage.search({ text: '"long trunks"' });
      const collection = await storage.createCollection({ name: 'From a Worker' });
      const added = await storage.addToCollection(collection.id, [context.metadata.ref.id]);
      await storage.kvSet('jobs:worker', { ran: 'workerd' });
      await storage.upsertVectors([
        { id: 'x', videoId: context.metadata.ref.id, startSec: 0, endSec: 1, text: 'x', model: 'tiny', vector: [1, 0] },
        { id: 'y', videoId: context.metadata.ref.id, startSec: 1, endSec: 2, text: 'y', model: 'tiny', vector: [0, 1] },
      ]);
      const near = await storage.queryVectors({ model: 'tiny', vector: [0.2, 1] });
      return Response.json({
        backend: storage.backend,
        segments: back?.transcript.segments.length,
        hits: hits.map((h) => h.text),
        collection: added.videoIds,
        kv: await storage.kvGet('jobs:worker'),
        near: near.map((h) => h.id),
      });
    } catch (err) {
      const e = err as { code?: string; message?: string; hint?: string };
      return Response.json({ error: e.message, code: e.code, hint: e.hint }, { status: 500 });
    }
  },
};
