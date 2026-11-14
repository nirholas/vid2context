/**
 * createWorkersContext passes real Cloudflare binding objects (workerd's D1,
 * R2 and KV from Miniflare) through as ctx.bindings and keeps strings in env.
 * Imports the whole Workers registry, so it needs every Workers provider package to load.
 */
import { createWorkersContext } from '@vid2context/registry/workers';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let mf: Miniflare;
let bindings: Record<string, unknown>;

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'vid2context-plumbing' },
      r2Buckets: ['R2'],
      kvNamespaces: ['KV'],
    }),
  );
  bindings = await mf.getBindings();
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe('createWorkersContext', () => {
  it('keeps strings in env and passes binding objects through as ctx.bindings', () => {
    const ctx = createWorkersContext({ ...bindings, FOO: 'bar', VID2CONTEXT_D1: 'DB' });
    expect(ctx.env).toEqual({ FOO: 'bar', VID2CONTEXT_D1: 'DB' });
    expect(Object.keys(ctx.bindings ?? {}).sort()).toEqual(['DB', 'KV', 'R2']);
    expect(ctx.bindings?.DB).toBe(bindings.DB);
    expect(ctx.runtime).toBe('workers');
  });

  it('leaves existing callers with only string env unchanged', () => {
    const ctx = createWorkersContext({ GROQ_API_KEY: 'gsk' });
    expect(ctx.env).toEqual({ GROQ_API_KEY: 'gsk' });
    expect(ctx.bindings).toEqual({});
  });
});
