/**
 * HTTP route for search, as a Hono sub-app. Item 46 (or the integration
 * pass) mounts it: `app.route('/api/v1', searchRoutes(deps))`.
 *
 *   GET /search?q=&collectionId=&videoIds=&limit=
 *       optional: mode=hybrid|keyword|vector, rerank=1, channel=, origin=,
 *       publishedAfter=, publishedBefore=
 *
 * Response: `{ hits: (SearchHit & { url?, chapterTitle?, sources, snippet, ... })[], meta }`.
 * Errors are thrown as Vid2ContextError and handled by the main app's
 * onError, so they get the standard body and status.
 */
import { type Ctx, type Registry, type Storage, type TranscriptOrigin, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { type EngineSettings, engineFor, resolveStorage } from './shared.ts';

export interface RouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  /** The library backend. Omitted: the registry's enabled storage provider, else a process-local MemoryStorage. */
  storage?: (ctx: Ctx) => Promise<Storage | null>;
  /** Engine settings (embedModel, keyword backend, fusion, chunking). */
  search?: EngineSettings;
}

const ORIGINS: TranscriptOrigin[] = ['creator-captions', 'auto-captions', 'native-transcript', 'stt', 'video-model'];
const TRUE = new Set(['1', 'true', 'yes']);

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function list(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function searchRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get('/search', async (c) => {
    const q = c.req.query('q');
    if (!q || q.trim() === '') throw bad('Missing the q query parameter.', 'Pass ?q=<words to search for>.');

    const limitRaw = c.req.query('limit');
    let limit: number | undefined;
    if (limitRaw !== undefined && limitRaw !== '') {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw bad('limit must be an integer from 1 to 100.', 'Pass ?limit=10.');
    }

    const mode = c.req.query('mode');
    if (mode !== undefined && mode !== 'hybrid' && mode !== 'keyword' && mode !== 'vector') {
      throw bad(`Unknown mode: ${mode}.`, 'Use mode=hybrid (default), keyword or vector.');
    }

    const origins = list(c.req.query('origin'));
    if (origins?.some((o) => !ORIGINS.includes(o as TranscriptOrigin))) {
      throw bad(`Unknown origin in ${c.req.query('origin')}.`, `Use one or more of: ${ORIGINS.join(', ')}.`);
    }

    const ctx = deps.makeCtx(c.req.raw);
    const storage = await resolveStorage(deps.registry, deps.storage, ctx);
    const engine = engineFor(deps.registry, storage, ctx, deps.search);
    const result = await engine.search(
      {
        query: q,
        limit,
        collectionId: c.req.query('collectionId') || undefined,
        videoIds: list(c.req.query('videoIds')),
        channel: c.req.query('channel') || undefined,
        publishedAfter: c.req.query('publishedAfter') || undefined,
        publishedBefore: c.req.query('publishedBefore') || undefined,
        origin: origins as TranscriptOrigin[] | undefined,
        mode: mode as 'hybrid' | 'keyword' | 'vector' | undefined,
        rerank: TRUE.has((c.req.query('rerank') ?? '').toLowerCase()),
      },
      { ctx },
    );
    return c.json(result);
  });

  return app;
}
