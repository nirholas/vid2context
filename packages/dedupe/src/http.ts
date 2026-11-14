/**
 * HTTP sub-app: POST /duplicates, mounted by packages/server under /api/v1.
 * Errors propagate to the main app's onError, which renders the standard
 * error body and status.
 */
import { type Ctx, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { type DuplicatesRequest, duplicatesReport } from './load.ts';

export interface RouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  storage: (ctx: Ctx) => Promise<Storage>;
}

function badBody(message: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, {
    hint: 'Send JSON like { "inputs": ["<video url>", "<video url>"] } or { "collectionId": "<id>" }.',
  });
}

/**
 * `POST /duplicates` with `{ inputs?, collectionId?, options? }`. Returns the
 * groups (reuploads and clips with evidence and offsets), related pairs,
 * `representativeOf`, the compared videos and any inputs that failed to load.
 */
export function dedupeRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  app.post('/duplicates', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badBody('The request body is not valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badBody('The request body must be a JSON object.');
    const { inputs, collectionId, options } = body as Record<string, unknown>;
    if (collectionId !== undefined && typeof collectionId !== 'string') throw badBody('`collectionId` must be a string.');
    const ctx = deps.makeCtx(c.req.raw);
    const req: DuplicatesRequest = {
      inputs: inputs as string[] | undefined,
      collectionId: collectionId || undefined,
      options: options as DuplicatesRequest['options'],
    };
    const storage = req.collectionId || (req.inputs?.length ?? 0) > 0 ? await deps.storage(ctx) : null;
    return c.json(await duplicatesReport(req, { registry: deps.registry, storage }, ctx));
  });
  return app;
}
