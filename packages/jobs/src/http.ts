/**
 * The /jobs routes from docs/contracts/http-api.md, as a Hono sub-app the
 * server mounts under /api/v1:
 *
 *   POST   /jobs              { kind, input, options? }  -> 202 Job
 *   GET    /jobs/:id                                      -> Job
 *   GET    /jobs/:id/events                               -> text/event-stream
 *   DELETE /jobs/:id                                      -> 202 Job (cancel requested)
 *   POST   /jobs/:id/run      Cloud Tasks only, present when `run` is configured
 *
 * Errors are thrown as Vid2ContextError so the main app's onError renders the
 * standard body and status.
 */
import { type Ctx, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import type { GoogleOidcVerifier } from './cloud-tasks.ts';
import { publicJob } from './store.ts';
import type { ConsumerDeps, Dispatch } from './remote.ts';
import { runDispatchedJob } from './remote.ts';
import { parseLastEventId, toSSE } from './sse.ts';
import type { JobQueue } from './types.ts';

export interface RouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  storage: (ctx: Ctx) => Promise<Storage>;
}

/** Enables POST /jobs/:id/run for Google Cloud Tasks. */
export interface RunEndpointOptions {
  verifier: GoogleOidcVerifier;
  /** Consumer dependencies for one run (store, kinds, registry, storage, ctx). */
  consumer: (ctx: Ctx) => ConsumerDeps | Promise<ConsumerDeps>;
  /** Re-dispatches a job that asked for a retry, scheduled after its backoff. */
  dispatch: Dispatch;
}

export interface JobsRouteDeps extends RouteDeps {
  queue: JobQueue;
  run?: RunEndpointOptions;
  /** SSE heartbeat interval. Default 15000 ms. */
  heartbeatMs?: number;
}

const MAX_BODY_BYTES = 1_000_000;

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Vid2ContextError('too-large', 'The job request body is larger than 1 MB.', { hint: 'Send fewer inputs per job.' });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw bad('The request body is not valid JSON.', 'Send {"kind": "...", "input": ..., "options": {...}} with content-type application/json.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw bad('The request body must be a JSON object.', 'Send {"kind": "...", "input": ..., "options": {...}}.');
  }
  return body as Record<string, unknown>;
}

function notFound(id: string): Vid2ContextError {
  return new Vid2ContextError('not-found', `No job with id "${id}".`, {
    hint: 'Finished jobs expire after VID2CONTEXT_JOB_TTL_HOURS (default 72). Submit the job again.',
  });
}

export function jobsRoutes(deps: JobsRouteDeps): Hono {
  const app = new Hono();
  const { queue } = deps;

  app.post('/jobs', async (c) => {
    const body = await readBody(c.req.raw);
    if (typeof body.kind !== 'string' || !body.kind) {
      const kinds = queue.kinds();
      throw bad('Missing "kind".', kinds.length ? `Registered kinds: ${kinds.join(', ')}.` : 'No job kinds are registered.');
    }
    if (body.input === undefined) throw bad('Missing "input".', 'Pass the input the job kind expects, usually a URL.');
    const job = await queue.enqueue(body.kind, body.input, body.options as Record<string, unknown> | undefined);
    return c.json(job, 202);
  });

  app.get('/jobs/:id', async (c) => {
    const id = c.req.param('id');
    const job = await queue.get(id);
    if (!job) throw notFound(id);
    return c.json(job);
  });

  app.get('/jobs/:id/events', (c) =>
    toSSE(queue, c.req.param('id'), {
      lastEventId: parseLastEventId(c.req.header('last-event-id')),
      signal: c.req.raw.signal,
      ...(deps.heartbeatMs ? { heartbeatMs: deps.heartbeatMs } : {}),
    }),
  );

  app.delete('/jobs/:id', async (c) => {
    const job = await queue.cancel(c.req.param('id'));
    return c.json(job, 202);
  });

  if (deps.run) {
    const run = deps.run;
    app.post('/jobs/:id/run', async (c) => {
      const ctx = deps.makeCtx(c.req.raw);
      const auth = c.req.header('authorization') ?? '';
      const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
      try {
        if (!token) throw new Vid2ContextError('auth', 'Missing bearer token.', { status: 401, hint: 'Only Cloud Tasks may call this endpoint.' });
        await run.verifier.verify(token, ctx);
      } catch (err) {
        if (err instanceof Vid2ContextError && err.status === 401) {
          // 401, not the 502 the main app uses for `auth`: here the caller, not an upstream key, failed.
          return c.json({ error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }, attempts: [] }, 401);
        }
        throw err;
      }
      const id = c.req.param('id');
      const outcome = await runDispatchedJob(id, await run.consumer(ctx));
      if (outcome.status === 'retry') await run.dispatch(outcome.job, outcome.delayMs);
      // 200 for every outcome the job decided itself, so Cloud Tasks does not retry on top of our own backoff.
      return c.json({ outcome: outcome.status, job: outcome.job });
    });
  }

  return app;
}

export { publicJob };
