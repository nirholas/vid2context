/**
 * The sub-apps other packages export, mounted by createApp: their routes
 * answer through the main app, share its storage, middleware and error body.
 */
import { replayFetch, testContext } from '@vid2context/core/testing';
import { createJobQueue, registerBuiltinKinds } from '@vid2context/jobs';
import { describe, expect, it } from 'vitest';
import { makeApp, recordedRoutes, seededStorage, testRegistry } from './helpers.ts';

async function until<T>(get: () => Promise<T>, done: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('mounted sub-apps', () => {
  it('serves collections and search over the same storage as the library routes', async () => {
    const { storage, collectionId } = await seededStorage();
    const { app } = makeApp({ storage });
    const list = await (await app.request('/api/v1/collections')).json();
    expect(list.collections.map((c: { id: string }) => c.id)).toContain(collectionId);

    const res = await app.request(`/api/v1/search?q=elephants&collectionId=${collectionId}&mode=keyword`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits[0]).toMatchObject({ videoId: 'youtube:jNQXAC9IVRw' });
    expect(res.headers.get('x-robots-tag')).toBe('noindex');

    // Errors thrown inside a sub-app get the standard body.
    const bad = await app.request('/api/v1/search');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'bad-request', hint: expect.any(String) }, attempts: [] });
  });

  it('mounts /jobs when given a queue, and runs collection ingest as a job', async () => {
    const storage = (await seededStorage()).storage;
    const fetch = replayFetch(recordedRoutes());
    const queue = createJobQueue({ registry: testRegistry(), ctx: testContext({ fetch, env: {} }), storage });
    registerBuiltinKinds(queue);
    try {
      const { app } = makeApp({ storage, app: { jobs: { queue } } });
      const post = await app.request('/api/v1/jobs', {
        method: 'POST',
        body: JSON.stringify({ kind: 'context', input: 'https://youtu.be/jNQXAC9IVRw' }),
      });
      expect(post.status).toBe(202);
      const job = await post.json();
      const finished = await until(
        async () => (await app.request(`/api/v1/jobs/${job.id}`)).json(),
        (j: { status: string }) => j.status === 'succeeded' || j.status === 'failed',
      );
      expect(finished.status).toBe('succeeded');

      const created = await (
        await app.request('/api/v1/collections', { method: 'POST', body: JSON.stringify({ name: 'Zoo' }) })
      ).json();
      const ingest = await app.request(`/api/v1/collections/${created.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ inputs: ['https://youtu.be/jNQXAC9IVRw'] }),
      });
      expect(ingest.status).toBe(202);
      expect(await ingest.json()).toMatchObject({ kind: 'ingest' });
    } finally {
      await queue.close();
    }
  });

  it('leaves /jobs unmounted without a queue', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/v1/jobs/abc')).status).toBe(404);
  });

  it('serves the remote MCP endpoints at the root, outside the /api middleware', async () => {
    const { app } = makeApp();
    const card = await app.request('/mcp/server-card');
    expect(card.status).toBe(200);
    expect(card.headers.get('x-request-id')).toBeTruthy();
    expect(card.headers.get('x-robots-tag')).toBeNull();
    // mcp-http answers its own auth errors: with no credentials configured it refuses every request.
    const mcp = await app.request('/mcp', { method: 'POST', body: '{}' });
    expect(mcp.status).toBe(401);
    expect((await mcp.json()).error.hint).toContain('VID2CONTEXT_MCP_TOKENS');
  });
});

describe('hosted mode (@vid2context/accounts)', () => {
  const HOSTED = {
    VID2CONTEXT_HOSTED: '1',
    VID2CONTEXT_ANONYMOUS: '1',
    VID2CONTEXT_SESSION_SECRET: 'a-session-secret-of-at-least-32-characters-for-tests',
    VID2CONTEXT_API_KEYS: 'plain-key-55e0aa',
  };

  it('keeps the account routes hidden when hosted mode is off', async () => {
    const { app } = makeApp();
    const me = await app.request('/api/v1/me');
    expect(me.status).toBe(404);
    expect((await me.json()).error.hint).toContain('VID2CONTEXT_HOSTED=1');
  });

  it('lets accounts guard /api/* instead of the server keys, and meters pipeline work per caller', async () => {
    const { app } = makeApp({ env: HOSTED });
    // Anonymous callers get the anonymous plan; the server's own API key is not asked for.
    const res = await app.request('/api/v1/context?url=jNQXAC9IVRw&mode=captions', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { metadata: { title: string } }).metadata.title).toBe('Me at the zoo');
    // /me needs a signed-in account.
    const me = await app.request('/api/v1/me');
    expect(me.status).toBe(401);
    expect((await me.json()).error.code).toBeTruthy();
    // A v2c_ key that does not exist is refused by accounts, not by the server's key list.
    const bad = await app.request('/api/v1/formats', { headers: { authorization: 'Bearer v2c_notarealkey' } });
    expect(bad.status).toBe(401);
  });
});
