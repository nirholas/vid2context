/**
 * HTTP routes for the research package, as a Hono sub-app. Item 46 (or the
 * integration pass) mounts it: `app.route('/api/v1', researchRoutes(deps))`.
 *
 *   POST /research            { urls, query, contextSec?, maxExcerpts?, maxTokens? }
 *   GET  /caption-languages?url=
 *   GET  /key-moments?url=&count=
 *
 * Errors are thrown as Vid2ContextError and handled by the main app's
 * onError, so they get the standard body and status.
 */
import { type Ctx, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { listCaptionLanguages } from './languages.ts';
import { keyMoments } from './moments.ts';
import { MAX_VIDEOS, research } from './research.ts';

export interface RouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  /** Saved contexts, used as a cache. Omitted: the registry's enabled storage provider, if any. */
  storage?: (ctx: Ctx) => Promise<Storage | null>;
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function readUrl(v: string | undefined): string {
  if (!v) throw bad('Missing the url query parameter.', 'Pass ?url=<video URL>.');
  return v;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw bad(`${key} must be a number.`, `Send ${key} as a JSON number, or leave it out.`);
  return v;
}

export function researchRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  const depsFor = (req: Request) => ({ registry: deps.registry, ctx: deps.makeCtx(req), storage: deps.storage });

  app.post('/research', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw bad(
        'The body must be JSON.',
        'Send {"urls": ["<video URL>"], "query": "<words>"} with Content-Type: application/json.',
      );
    }
    if (!body || typeof body !== 'object') throw bad('The body must be a JSON object.', 'Send {"urls": [...], "query": "..."}.');
    const urls = body.urls;
    if (!Array.isArray(urls) || urls.length === 0 || urls.some((u) => typeof u !== 'string')) {
      throw bad('urls must be a non-empty array of strings.', `Send 1 to ${MAX_VIDEOS} video URLs, or one playlist URL.`);
    }
    if (typeof body.query !== 'string') throw bad('query must be a string.', 'Send the words to look for as "query".');
    const result = await research(
      urls as string[],
      body.query,
      {
        contextSec: optionalNumber(body, 'contextSec'),
        maxExcerpts: optionalNumber(body, 'maxExcerpts'),
        maxTokens: optionalNumber(body, 'maxTokens'),
      },
      depsFor(c.req.raw),
    );
    return c.json(result);
  });

  app.get('/caption-languages', async (c) => {
    return c.json(await listCaptionLanguages(readUrl(c.req.query('url')), depsFor(c.req.raw)));
  });

  app.get('/key-moments', async (c) => {
    const raw = c.req.query('count');
    const count = raw === undefined || raw === '' ? undefined : Number(raw);
    if (count !== undefined && !Number.isInteger(count))
      throw bad(`count must be a whole number, got "${raw}".`, 'Pass count from 1 to 30.');
    return c.json(await keyMoments(readUrl(c.req.query('url')), { count }, depsFor(c.req.raw)));
  });

  return app;
}
