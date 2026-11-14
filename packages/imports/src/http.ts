/**
 * HTTP route for transcript import, as a Hono sub-app. packages/server mounts
 * it: `app.route('/api/v1', importRoutes(deps))`.
 *
 *   POST /imports  { url, text | segments, language?, filename?, via?, captionKind? }
 *               -> 201 { context, format, saved }
 *
 * The body is capped at 5 MB (`too-large`, 413). Errors are thrown as
 * Vid2ContextError and handled by the main app's onError, so they get the
 * standard body and status.
 */
import { type Ctx, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { importTranscript, validateImportRequest } from './import.ts';

/** Largest request body POST /imports accepts. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface RouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  /** Where imports are saved. Omitted: the registry's enabled storage provider, if any. */
  storage?: (ctx: Ctx) => Promise<Storage | null>;
  /**
   * Hosted mode: imports are returned and never saved, because instance
   * storage is shared and an imported transcript is not verified. Omitted:
   * VID2CONTEXT_HOSTED from the request's env (1, true or yes).
   */
  hosted?: (req: Request, ctx: Ctx) => boolean;
}

/** Same reading as @vid2context/accounts and the server config. */
export function isHosted(ctx: Ctx): boolean {
  return ['1', 'true', 'yes'].includes(ctx.env.VID2CONTEXT_HOSTED ?? '');
}

function tooLarge(): Vid2ContextError {
  return new Vid2ContextError('too-large', 'The import is larger than 5 MB.', {
    hint: 'Import a shorter transcript, or send segments instead of the raw file.',
  });
}

/**
 * Read the body as text, refusing more than `max` bytes: by Content-Length
 * when it is sent, else while streaming. The Request is read in place, so the
 * server's per-request Ctx (keyed by the Request) still applies.
 */
async function readCapped(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function importRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.post('/imports', async (c) => {
    const raw = await readCapped(c.req.raw, MAX_IMPORT_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Vid2ContextError('bad-request', 'The body must be JSON.', {
        hint: 'Send {"url": "<video URL>", "text": "<transcript>"} with Content-Type: application/json.',
      });
    }
    const request = validateImportRequest(body);
    const ctx = deps.makeCtx(c.req.raw);
    const hosted = deps.hosted ? deps.hosted(c.req.raw, ctx) : isHosted(ctx);
    // Hosted mode never saves, so it never opens storage either.
    const storage = hosted ? null : deps.storage ? await deps.storage(ctx) : await deps.registry.openStorage(ctx);
    const result = await importTranscript(deps.registry, request, { storage, hosted }, ctx);
    return c.json(result, 201);
  });

  return app;
}
