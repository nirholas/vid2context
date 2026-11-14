/**
 * Hono sub-app for the webhook routes in docs/contracts/http-api.md ("Wave 2
 * routes"). Paths are relative to /api/v1; the server mounts it with
 * `app.route('/api/v1', webhookRoutes(deps))`. Errors are thrown as
 * Vid2ContextError so the main app renders the standard error body.
 */
import { type Ctx, MemoryKv, type Storage, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { type DeliveryOptions, sendTestPing } from './deliver.ts';
import { publicView, WebhookStore } from './store.ts';

export interface WebhookRouteDeps {
  makeCtx: (req: Request) => Ctx;
  storage: (ctx: Ctx) => Promise<Storage>;
  /** Delivery settings for test pings (timeout, URL guard). */
  delivery?: DeliveryOptions;
  /**
   * Share one store resolver between these routes and the emitters (see
   * webhookStoreResolver), so hooks registered here are the ones events reach
   * even when the Storage backend has no KvStore.
   */
  stores?: (ctx: Ctx) => Promise<WebhookStore>;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through to the error below
  }
  throw new Vid2ContextError('bad-request', 'The request body must be a JSON object.', {
    hint: 'Send Content-Type: application/json with { "url": "https://example.com/hook", "events": ["collection.updated"] }.',
  });
}

/**
 * Builds the store for a request: the configured Storage when it implements
 * KvStore, otherwise one process-local MemoryKv shared by every request of
 * this sub-app (hooks then last until the process restarts).
 */
export function webhookStoreResolver(deps: Pick<WebhookRouteDeps, 'storage'>): (ctx: Ctx) => Promise<WebhookStore> {
  const fallback = new MemoryKv();
  return async (ctx) => WebhookStore.forStorage(await deps.storage(ctx), fallback);
}

export function webhookRoutes(deps: WebhookRouteDeps): Hono {
  const app = new Hono();
  const storeFor = deps.stores ?? webhookStoreResolver(deps);

  app.get('/webhooks', async (c) => {
    const store = await storeFor(deps.makeCtx(c.req.raw));
    return c.json({ webhooks: await store.list() });
  });

  app.post('/webhooks', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const body = await readJson(c.req.raw);
    const store = await storeFor(ctx);
    const record = await store.create(
      { url: body.url as string, events: body.events as string[], description: body.description as string | undefined },
      ctx,
      deps.delivery,
    );
    // The only response that ever contains the secret.
    return c.json({ ...publicView(record), secret: record.secret }, 201);
  });

  app.delete('/webhooks/:id', async (c) => {
    const store = await storeFor(deps.makeCtx(c.req.raw));
    const id = c.req.param('id');
    if (!(await store.delete(id))) {
      throw new Vid2ContextError('not-found', `Webhook not found: ${id}`, {
        hint: 'GET /api/v1/webhooks lists the registered webhooks.',
      });
    }
    return c.body(null, 204);
  });

  app.post('/webhooks/:id/test', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const store = await storeFor(ctx);
    const result = await sendTestPing(c.req.param('id'), store, ctx, deps.delivery);
    const record = await store.get(result.hookId);
    return c.json({
      delivered: result.outcome === 'delivered',
      messageId: result.messageId,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.error ? { error: result.error } : {}),
      ms: result.ms,
      webhook: record ? publicView(record) : undefined,
    });
  });

  return app;
}
