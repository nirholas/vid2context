/**
 * HTTP route `GET /skips?url=&categories=`, relative to /api/v1. Item 46 (or
 * the integration pass) mounts it with `app.route('/api/v1', skipsRoutes(deps))`.
 * Errors propagate to the main app's onError, which renders the standard body.
 */
import { type Ctx, type Registry, type Storage, type Transcript, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { buildReport } from './report.ts';
import { getSkipSegments, parseCategories } from './sponsorblock.ts';

export interface SkipsRouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  storage?: (ctx: Ctx) => Promise<Storage>;
}

/**
 * `GET /skips` answers `{ videoId, segments, coveredSec, source: 'sponsorblock', attribution }`,
 * plus `coveredShare` and `highlight`, `fullVideo`, `chapters` and `note` when they apply.
 * It never fetches a transcript: when storage holds a saved context for the video, its duration
 * and transcript fill in `coveredShare` and each segment's transcript coverage.
 */
export function skipsRoutes(deps: SkipsRouteDeps): Hono {
  const app = new Hono();

  app.get('/skips', async (c) => {
    const ctx = deps.makeCtx(c.req.raw);
    const url = c.req.query('url');
    if (!url)
      throw new Vid2ContextError('bad-request', 'Missing the url query parameter.', { hint: 'Pass ?url=<YouTube URL or id>.' });
    const categoriesParam = c.req.query('categories');
    const categories = categoriesParam ? parseCategories(categoriesParam) : undefined;
    const { ref } = deps.registry.resolve(url);
    const lookup = await getSkipSegments(ref, ctx, categories ? { categories } : {});
    let durationSec: number | undefined;
    let transcript: Transcript | undefined;
    if (deps.storage && lookup.segments.length > 0) {
      const saved = await (await deps.storage(ctx)).getContext(ref.id);
      durationSec = saved?.metadata.durationSec;
      transcript = saved?.transcript;
    }
    return c.json(buildReport(ref, lookup, { ctx, transcript, durationSec }));
  });

  return app;
}
