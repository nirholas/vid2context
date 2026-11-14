import { attemptsOf, clearCooldowns, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { researchRoutes } from '../src/http.ts';
import { ctxWith, filledStorage, GWAGON, llmRoute, loadLlmFixture, makeRegistry, playerRoute, ZOO } from './helpers.ts';

const fixture = loadLlmFixture('key-moments-cCPsdFdlshc.json');
const storage = await filledStorage();

/** Mounted the way the server mounts sub-apps; the parent's onError writes the standard error body. */
function app() {
  const parent = new Hono();
  parent.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    return c.json(
      {
        error: { code: e?.code ?? 'internal', message: err.message, ...(e?.hint ? { hint: e.hint } : {}) },
        attempts: attemptsOf(err),
      },
      e?.code === 'bad-request' || e?.code === 'unsupported-input' ? 400 : e?.code === 'not-found' ? 404 : 500,
    );
  });
  parent.route(
    '/api/v1',
    researchRoutes({
      registry: makeRegistry(),
      makeCtx: () => ctxWith([playerRoute, llmRoute(fixture)]),
      storage: async () => storage,
    }),
  );
  return parent;
}

const post = (body: unknown) =>
  app().request('/api/v1/research', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => clearCooldowns());

describe('HTTP research routes', () => {
  it('POST /research returns results with excerpts', async () => {
    const res = await post({ urls: [GWAGON, ZOO], query: 'engine', maxExcerpts: 2, contextSec: 10 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ videoId: 'youtube:cCPsdFdlshc' });
    expect(body.results[0].excerpts).toHaveLength(2);
    expect(body.results[0].excerpts[0]).toMatchObject({
      startSec: 43.76,
      url: 'https://www.youtube.com/watch?v=cCPsdFdlshc&t=43s',
    });
    expect(typeof body.results[0].excerpts[0].context.before).toBe('string');
  });

  it('POST /research rejects bad bodies with 400 and a hint', async () => {
    for (const body of [{ query: 'engine' }, { urls: [GWAGON] }, { urls: [GWAGON], query: 'engine', contextSec: 'ten' }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('bad-request');
      expect(json.error.hint).toBeTruthy();
    }
    const raw = await app().request('/api/v1/research', { method: 'POST', body: 'not json' });
    expect(raw.status).toBe(400);
  });

  it('GET /caption-languages returns tracks and translation targets', async () => {
    const res = await app().request(`/api/v1/caption-languages?url=${encodeURIComponent(GWAGON)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tracks).toHaveLength(1);
    expect(body.translationTargets).toHaveLength(16);
    const missing = await app().request('/api/v1/caption-languages');
    expect(missing.status).toBe(400);
  });

  it('GET /key-moments returns moments and the rung', async () => {
    const res = await app().request(`/api/v1/key-moments?url=${encodeURIComponent(GWAGON)}&count=${fixture.options.count}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rung).toBe(fixture.rung);
    expect(body.moments.length).toBeGreaterThan(0);
    expect((await app().request(`/api/v1/key-moments?url=${encodeURIComponent(GWAGON)}&count=abc`)).status).toBe(400);
  });
});
