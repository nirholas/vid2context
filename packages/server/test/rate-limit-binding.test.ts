import { createHash } from 'node:crypto';
import { testContext } from '@vid2context/core/testing';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { testRegistry } from './helpers.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ALICE = 'alice-key-31c9e0';
const BOB = 'bob-key-8d42aa';
const env = {
  VID2CONTEXT_API_KEYS: [`alice:read:${sha(ALICE)}`, `bob:read:${sha(BOB)}`].join(', '),
  VID2CONTEXT_RATE_LIMIT_BINDING: 'RATE_LIMITER',
  // The token bucket would allow plenty; the binding's own limit (2 per 60 s) is what must apply.
  VID2CONTEXT_RATE_LIMIT: '1000',
};

// A real Workers rate limiting binding, run locally by Miniflare (workerd), the same as `wrangler dev`.
let mf: Miniflare;
let binding: unknown;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null, { status: 204 }) } }',
      compatibilityDate: '2026-10-01',
      ratelimits: { RATE_LIMITER: { namespace_id: '1001', simple: { limit: 2, period: 60 } } },
    }),
  );
  binding = (await mf.getBindings()).RATE_LIMITER;
}, 60_000);
afterAll(async () => mf?.dispose());

/** One app per Worker isolate, as src/workers.ts builds them; each has its own in-memory KV. */
const isolate = () =>
  createApp({
    registry: testRegistry(),
    makeCtx: (req) => ({ ...testContext({ env, signal: req.signal }), bindings: { RATE_LIMITER: binding } }),
  });
const as = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

describe('rate limiting through the Workers binding', () => {
  it('counts requests across isolates, which the per-isolate memory bucket cannot', async () => {
    const a = isolate();
    const b = isolate();
    expect((await a.request('/api/v1/formats', as(ALICE))).status).toBe(200);
    expect((await b.request('/api/v1/formats', as(ALICE))).status).toBe(200);
    // Third request, on a third isolate with an empty bucket: the shared binding refuses it.
    const limited = await isolate().request('/api/v1/formats', as(ALICE));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({ error: { code: 'rate-limited' } });
    // Another key is counted separately.
    expect((await a.request('/api/v1/formats', as(BOB))).status).toBe(200);
  });

  it('falls back to the token bucket when the named binding is missing', async () => {
    const app = createApp({
      registry: testRegistry(),
      makeCtx: (req) =>
        testContext({ env: { ...env, VID2CONTEXT_RATE_LIMIT: '1', VID2CONTEXT_RATE_BURST: '1' }, signal: req.signal }),
    });
    expect((await app.request('/api/v1/formats', as(ALICE))).headers.get('x-ratelimit-limit')).toBe('1');
    expect((await app.request('/api/v1/formats', as(ALICE))).status).toBe(429);
  });
});
