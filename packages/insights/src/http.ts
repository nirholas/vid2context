/**
 * HTTP routes for insights, as a Hono sub-app. Item 46 (or the integration
 * pass) mounts it: `app.route('/api/v1', insightsRoutes(deps))`.
 *
 *   POST /briefs   { collectionId?, inputs?, question?, template? }          -> 202 Job (result: Brief)
 *   POST /extract  { inputs?, collectionId?, template?, schema?, question? } -> 202 Job (result: ExtractionResult)
 *
 * With `queue` (a @vid2context/jobs JobQueue) the work runs as a job of kind
 * `brief` or `extract`, the kinds are registered on that queue, and the
 * client follows GET /jobs/:id or /jobs/:id/events. Without a queue the route
 * runs synchronously and answers 200 with the result itself.
 *
 * Bodies are validated before anything is queued, so a bad request fails
 * with 400 at once. Errors are thrown as Vid2ContextError and rendered by the
 * main app's onError.
 */
import { type Ctx, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import type { JobQueue } from '@vid2context/jobs';
import { Hono } from 'hono';
import { buildBrief } from './brief.ts';
import { extract } from './extract.ts';
import { BRIEF_JOB, EXTRACT_JOB, registerInsightsJobs } from './jobs.ts';
import { loadContexts } from './load.ts';
import { parseBriefRequest, parseExtractRequest } from './parse.ts';

export interface RouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  storage?: (ctx: Ctx) => Promise<Storage | null>;
}

export interface InsightsRouteDeps extends RouteDeps {
  /** Run briefs and extractions as background jobs (202 Job). Omitted: answer synchronously (200 with the result). */
  queue?: JobQueue;
}

const MAX_BODY_BYTES = 200_000;

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Vid2ContextError('too-large', 'The request body is larger than 200 KB.', {
      hint: 'Send a smaller schema or fewer inputs.',
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Vid2ContextError('bad-request', 'The body must be JSON.', {
      hint: 'Send {"inputs": ["<video URL>"], "question": "..."} with Content-Type: application/json.',
    });
  }
}

export function insightsRoutes(deps: InsightsRouteDeps): Hono {
  const app = new Hono();
  const { queue } = deps;
  if (queue && !(queue.kinds().includes(BRIEF_JOB) && queue.kinds().includes(EXTRACT_JOB))) registerInsightsJobs(queue);
  const loadDeps = (ctx: Ctx) => ({ registry: deps.registry, ctx, storage: deps.storage });

  app.post('/briefs', async (c) => {
    const req = parseBriefRequest(await readJson(c.req.raw));
    if (queue) return c.json(await queue.enqueue(BRIEF_JOB, req), 202);
    const ctx = deps.makeCtx(c.req.raw);
    const contexts = await loadContexts(req, loadDeps(ctx));
    return c.json(
      await buildBrief(contexts, { question: req.question, template: req.template }, { registry: deps.registry, ctx }),
    );
  });

  app.post('/extract', async (c) => {
    const req = parseExtractRequest(await readJson(c.req.raw));
    if (queue) return c.json(await queue.enqueue(EXTRACT_JOB, req), 202);
    const ctx = deps.makeCtx(c.req.raw);
    const contexts = await loadContexts(req, loadDeps(ctx));
    return c.json(
      await extract(
        contexts,
        { template: req.template, schema: req.schema, question: req.question },
        { registry: deps.registry, ctx },
      ),
    );
  });

  return app;
}
