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
    const meta = await app.request('/.well-known/oauth-protected-resource/mcp');
    expect(meta.status).not.toBe(404);
    expect(meta.headers.get('x-request-id')).toBeTruthy();
    expect(meta.headers.get('x-robots-tag')).toBeNull();
    const mcp = await app.request('/mcp', { method: 'POST', body: '{}' });
    expect(mcp.status).not.toBe(404);
  });
});
