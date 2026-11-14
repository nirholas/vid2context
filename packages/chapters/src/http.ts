/**
 * HTTP routes for auto-chapters, as a Hono sub-app. Item 46 (or the
 * integration pass) mounts it: `app.route('/api/v1', chaptersRoutes(deps))`.
 *
 *   POST /chapters  { url, force?, llm?, summaries?, lang? }
 *                -> { chapters, producer, rung, source: 'auto', method, notes, attempts }
 *
 * Errors are thrown as Vid2ContextError and handled by the main app's
 * onError, so they get the standard body and status.
 */
import { type Ctx, getVideoContext, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { autoChapters } from './chapters.ts';

export interface RouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  /** Saved contexts, used as a cache. Omitted: the registry's enabled storage provider, if any. */
  storage?: (ctx: Ctx) => Promise<Storage | null>;
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw bad(`${key} must be true or false.`, `Send ${key} as a JSON boolean, or leave it out.`);
  return v;
}

export function chaptersRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.post('/chapters', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw bad('The body must be JSON.', 'Send {"url": "<video URL>"} with Content-Type: application/json.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw bad('The body must be a JSON object.', 'Send {"url": "<video URL>"}.');
    }
    const b = body as Record<string, unknown>;
    if (typeof b.url !== 'string' || !b.url.trim()) throw bad('url must be a non-empty string.', 'Send {"url": "<video URL>"}.');
    if (b.lang !== undefined && typeof b.lang !== 'string')
      throw bad('lang must be a string.', 'Send a BCP-47 code such as "en".');
    const ctx = deps.makeCtx(c.req.raw);
    const storage = deps.storage ? await deps.storage(ctx) : await deps.registry.openStorage(ctx);
    const context = await getVideoContext(
      deps.registry,
      b.url,
      { storage, ...(typeof b.lang === 'string' ? { language: b.lang } : {}) },
      ctx,
    );
    const result = await autoChapters(
      deps.registry,
      context,
      { force: optionalBoolean(b, 'force'), llm: optionalBoolean(b, 'llm'), summaries: optionalBoolean(b, 'summaries') },
      ctx,
    );
    return c.json({
      videoId: context.metadata.ref.id,
      chapters: result.chapters,
      producer: result.producer,
      rung: result.rung ?? null,
      model: result.model ?? null,
      source: result.source,
      method: result.method,
      durationSec: result.durationSec,
      notes: result.notes,
      attempts: result.attempts,
    });
  });

  return app;
}
