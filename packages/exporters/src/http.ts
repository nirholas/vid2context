/**
 * HTTP routes for note exports, mounted by the server under /api/v1:
 *
 *   POST /exports/obsidian  { inputs?, collectionId?, folder? }        -> { files: { path, content }[], missing }
 *   POST /exports/notion    { inputs?, collectionId?, parentPageId? }  -> { pages: { videoId, url, pageId, status }[], missing }
 *
 * The Obsidian route never writes on the server: it returns the files for the
 * caller to write (or for the bundle route to zip). Errors are thrown as
 * Vid2ContextError and rendered by the main app's onError.
 */
import { type Ctx, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { loadContexts } from './load.ts';
import { exportNotion, notionConfig } from './notion.ts';
import { renderObsidian } from './obsidian.ts';

export interface ExporterRouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  /** Library storage, for collections and cached contexts. */
  storage?: (ctx: Ctx) => Promise<Storage>;
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw bad('The request body is not valid JSON.', 'Send a JSON object with Content-Type: application/json.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw bad('The request body must be a JSON object.', 'Send { "inputs": [...] } or { "collectionId": "..." }.');
  return body as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad(`"${key}" must be a string.`, `Pass "${key}" as a string or leave it out.`);
  return v;
}

function optionalInputs(body: Record<string, unknown>): string[] | undefined {
  const v = body.inputs;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
    throw bad('"inputs" must be an array of strings.', 'Pass video or playlist URLs as "inputs".');
  return v as string[];
}

export function exporterRoutes(deps: ExporterRouteDeps): Hono {
  const app = new Hono();

  /** Parse the body, run `check` (config errors surface before any video is fetched), then load the contexts. */
  const selection = async (req: Request, check?: (body: Record<string, unknown>, ctx: Ctx) => void) => {
    const body = await readBody(req);
    const ctx = deps.makeCtx(req);
    check?.(body, ctx);
    const storage = deps.storage ? await deps.storage(ctx) : null;
    const loaded = await loadContexts(
      { registry: deps.registry, storage },
      { inputs: optionalInputs(body), collectionId: optionalString(body, 'collectionId') },
      ctx,
    );
    return { body, ctx, loaded };
  };

  app.post('/exports/obsidian', async (c) => {
    const { body, loaded } = await selection(c.req.raw);
    const files = renderObsidian(loaded.contexts, { collection: loaded.collection, folder: optionalString(body, 'folder') });
    return c.json({ files, missing: loaded.missing });
  });

  app.post('/exports/notion', async (c) => {
    const { body, ctx, loaded } = await selection(c.req.raw, (b, ctx) => {
      notionConfig({ parentPageId: optionalString(b, 'parentPageId') }, ctx);
    });
    const pages = await exportNotion(loaded.contexts, { parentPageId: optionalString(body, 'parentPageId') }, ctx);
    return c.json({ pages, missing: loaded.missing });
  });

  return app;
}
