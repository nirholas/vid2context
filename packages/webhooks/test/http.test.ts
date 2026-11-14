import { MemoryStorage, Registry } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { createApp } from '@vid2context/server';
import { afterEach, describe, expect, it } from 'vitest';
import { webhookRoutes } from '../src/http.ts';
import { verifyWebhook } from '../src/signing.ts';
import { type Receiver, startReceiver } from './receiver.ts';

// The real HTTP app from packages/server with this package's routes mounted
// the way the server mounts sub-apps, so errors get the standard body. No
// providers are needed: these routes never fetch a video.
function makeApp(env: Record<string, string>) {
  const storage = new MemoryStorage();
  const makeCtx = () => testContext({ env, fetch: globalThis.fetch });
  const app = createApp({ registry: new Registry([], 'node'), makeCtx, storage: async () => storage });
  app.route('/api/v1', webhookRoutes({ makeCtx, storage: async () => storage }));
  return app;
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let receiver: Receiver | undefined;
afterEach(async () => {
  await receiver?.close();
  receiver = undefined;
});

describe('webhook routes', () => {
  it('creates, lists, tests and deletes a webhook; the secret is shown once', async () => {
    receiver = await startReceiver((_req, res) => res.writeHead(200).end());
    const app = makeApp({ VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL: '1' });

    const created = await app.request(
      '/api/v1/webhooks',
      json({ url: receiver.url, events: ['collection.updated', 'job.failed'] }),
    );
    expect(created.status).toBe(201);
    const hook = (await created.json()) as { id: string; secret: string; url: string; events: string[]; failures: number };
    expect(hook).toMatchObject({ url: receiver.url, events: ['collection.updated', 'job.failed'], failures: 0 });
    expect(hook.secret).toMatch(/^whsec_/);

    const listed = await app.request('/api/v1/webhooks');
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as { webhooks: Record<string, unknown>[] };
    expect(list.webhooks.map((w) => w.id)).toEqual([hook.id]);
    expect(JSON.stringify(list)).not.toContain(hook.secret);

    const tested = await app.request(`/api/v1/webhooks/${hook.id}/test`, { method: 'POST' });
    expect(tested.status).toBe(200);
    const ping = (await tested.json()) as { delivered: boolean; status: number; webhook: Record<string, unknown> };
    expect(ping).toMatchObject({ delivered: true, status: 200 });
    expect(JSON.stringify(ping)).not.toContain(hook.secret);
    const [got] = await receiver.waitFor(1);
    await expect(verifyWebhook(hook.secret, got?.headers ?? {}, got?.body ?? '')).resolves.toMatchObject({ type: 'test.ping' });

    expect((await app.request(`/api/v1/webhooks/${hook.id}`, { method: 'DELETE' })).status).toBe(204);
    const again = await app.request(`/api/v1/webhooks/${hook.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(((await again.json()) as { error: { code: string; hint: string } }).error).toMatchObject({ code: 'not-found' });
    expect(((await (await app.request('/api/v1/webhooks')).json()) as { webhooks: unknown[] }).webhooks).toEqual([]);
  });

  it('reports a failed test ping without failing the request', async () => {
    receiver = await startReceiver((_req, res) => res.writeHead(500).end());
    const app = makeApp({ VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL: '1' });
    const hook = (await (await app.request('/api/v1/webhooks', json({ url: receiver.url, events: ['*'] }))).json()) as {
      id: string;
    };
    const res = await app.request(`/api/v1/webhooks/${hook.id}/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ delivered: false, status: 500, error: 'HTTP 500', webhook: { failures: 1 } });
    expect(receiver.received).toHaveLength(1);
  });

  it('answers 400 with a hint for private URLs, unknown events and bad bodies, and 404 for unknown ids', async () => {
    const app = makeApp({});
    const priv = await app.request(
      '/api/v1/webhooks',
      json({ url: 'http://127.0.0.1:5678/webhook/x', events: ['video.ingested'] }),
    );
    expect(priv.status).toBe(400);
    const body = (await priv.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('bad-request');
    expect(body.error.hint).toContain('VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL=1');

    const events = await app.request('/api/v1/webhooks', json({ url: 'https://8.8.8.8/hook', events: ['nope'] }));
    expect(events.status).toBe(400);
    expect(((await events.json()) as { error: { hint: string } }).error.hint).toContain('collection.updated');

    const notJson = await app.request('/api/v1/webhooks', { method: 'POST', body: 'url=x' });
    expect(notJson.status).toBe(400);
    expect((await app.request('/api/v1/webhooks/wh_missing/test', { method: 'POST' })).status).toBe(404);
  });
});
