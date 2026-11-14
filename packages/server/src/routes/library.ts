/**
 * The personal library: saved video contexts in the registry's storage
 * backend, or a process-wide MemoryStorage when none is configured. Ids are
 * `platform:nativeId` and arrive URL-encoded (`youtube%3AjNQXAC9IVRw`).
 */
import { Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { jsonWithEtag, readInt } from '../http-util.ts';
import { json, P, ref } from '../openapi.ts';
import type { AppEnv, RouteDeps } from '../types.ts';

const V = '/api/v1';

function notSaved(id: string): Vid2ContextError {
  return new Vid2ContextError('not-found', `Not in the library: ${id}`, {
    hint: 'List saved videos with GET /api/v1/library. Fetching a video with GET /api/v1/context saves it.',
  });
}

/** Hono decodes path params once; decode again only when a client double-encoded the id. */
function readId(raw: string): string {
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function libraryRoutes({ services, docs }: RouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const idParam = { name: 'id', in: 'path' as const, description: 'Video id, URL-encoded: youtube%3AjNQXAC9IVRw.' };

  docs.add({
    method: 'get',
    path: `${V}/library`,
    summary: 'Saved videos, newest first, one page at a time.',
    tags: ['library'],
    params: [P.limit('Page size, 1 to 200 (default 50).'), { name: 'cursor', description: 'The cursor from the previous page.' }],
    responses: {
      '200': {
        description: 'Page<VideoSummary>.',
        content: json({ type: 'object', properties: { items: { type: 'array', items: ref('VideoSummary') }, cursor: { type: 'string' } }, required: ['items'] }),
      },
    },
  });
  app.get('/library', async (c) => {
    const ctx = services.ctxFor(c.req.raw);
    const limit = readInt('limit', c.req.query('limit'), { max: 200 }) ?? 50;
    const cursor = c.req.query('cursor') || undefined;
    return c.json(await (await services.storage(ctx)).listContexts({ limit, cursor }));
  });

  docs.add({
    method: 'get',
    path: `${V}/library/:id`,
    summary: 'One saved VideoContext.',
    tags: ['library'],
    params: [idParam],
    responses: {
      '200': { description: 'The VideoContext.', content: json(ref('VideoContext')), headers: { ETag: 'Version of the body; send it back as If-None-Match.' } },
      '304': { description: 'Not modified (If-None-Match matched).' },
    },
  });
  app.get('/library/:id', async (c) => {
    const id = readId(c.req.param('id'));
    const saved = await (await services.storage(services.ctxFor(c.req.raw))).getContext(id);
    if (!saved) throw notSaved(id);
    return jsonWithEtag(c, saved);
  });

  docs.add({
    method: 'delete',
    path: `${V}/library/:id`,
    summary: 'Remove a saved video (and from every collection).',
    tags: ['library'],
    params: [idParam],
    responses: { '204': { description: 'Deleted.' } },
  });
  app.delete('/library/:id', async (c) => {
    const id = readId(c.req.param('id'));
    const store = await services.storage(services.ctxFor(c.req.raw));
    if (!(await store.getContext(id))) throw notSaved(id);
    await store.deleteContext(id);
    return c.body(null, 204);
  });

  return app;
}
