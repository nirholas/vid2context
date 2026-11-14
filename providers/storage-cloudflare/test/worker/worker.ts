/**
 * Test Worker for ../live.test.ts: saves and searches contexts through the
 * D1 storage with local D1, R2 and KV in `wrangler dev`. It splits env the way
 * createWorkersContext does (strings to ctx.env, objects to ctx.bindings)
 * without importing the whole Workers registry, so other providers' state
 * cannot break this check.
 */
import { type Ctx, createContext, type Env, hasKv, Vid2ContextError, type VideoContext } from '@vid2context/core';
import provider from '../../src/index.ts';

function workersContext(env: Record<string, unknown>, signal: AbortSignal): Ctx {
  const strings: Env = {};
  const bindings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') strings[k] = v;
    else if (v !== undefined && v !== null) bindings[k] = v;
  }
  return createContext({ runtime: 'workers', env: strings, signal, bindings });
}

export default {
  async fetch(req: Request, env: Record<string, unknown>): Promise<Response> {
    const ctx = workersContext(env, req.signal);
    const url = new URL(req.url);
    try {
      const storage = await provider.create(ctx);
      if (url.pathname === '/save' && req.method === 'POST') {
        await storage.putContext((await req.json()) as VideoContext);
        return Response.json({ ok: true, backend: storage.backend });
      }
      if (url.pathname === '/search') {
        return Response.json(await storage.search({ text: url.searchParams.get('q') ?? '' }));
      }
      if (url.pathname === '/list') return Response.json(await storage.listContexts());
      if (url.pathname === '/kv' && hasKv(storage)) {
        await storage.kvSet('jobs:live', { at: 'wrangler dev' }, { ttlSec: 120 });
        return Response.json({ value: await storage.kvGet('jobs:live'), keys: (await storage.kvList('jobs:')).keys });
      }
      return new Response('not found', { status: 404 });
    } catch (err) {
      const e =
        err instanceof Vid2ContextError ? { code: err.code, message: err.message, hint: err.hint } : { message: String(err) };
      return Response.json({ error: e }, { status: 500 });
    }
  },
};
