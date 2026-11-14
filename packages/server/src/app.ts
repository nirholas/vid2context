/**
 * The vid2context HTTP API as one Hono app. Runtime entries (src/node.ts here;
 * Workers, Vercel and others later) build the registry for their runtime and
 * a Ctx per request, then serve `app.fetch`.
 */
import {
  attemptsOf,
  type Ctx,
  type ErrorCode,
  formatters,
  getVideoContext,
  type Registry,
  render,
  type TranscriptMode,
  Vid2ContextError,
} from '@vid2context/core';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export interface AppOptions {
  registry: Registry;
  /** Build a Ctx for one request (env, fetch, logger, the request's abort signal). */
  makeCtx: (req: Request) => Ctx;
  version?: string;
}

const MODES: TranscriptMode[] = ['auto', 'captions', 'stt', 'video'];

/** HTTP status for each error code. Upstream failures are 502/503, never 500. */
export const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  'unsupported-input': 400,
  'bad-request': 400,
  'not-found': 404,
  unavailable: 403,
  'no-transcript': 422,
  'too-large': 413,
  'rate-limited': 429,
  timeout: 504,
  blocked: 503,
  'no-provider': 503,
  'all-rungs-failed': 502,
  auth: 502,
  upstream: 502,
};

function badRequest(message: string, hint?: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function readMode(v: string | undefined): TranscriptMode {
  const mode = (v ?? 'auto') as TranscriptMode;
  if (!MODES.includes(mode)) throw badRequest(`Unknown mode "${v}".`, `Use one of: ${MODES.join(', ')}.`);
  return mode;
}

function readUrl(v: string | undefined): string {
  if (!v) throw badRequest('Missing the url query parameter.', 'Pass ?url=<video URL>.');
  return v;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    const status = e ? STATUS_BY_CODE[e.code] : 500;
    if (!e) opts.makeCtx(c.req.raw).log.error('unhandled error', { message: err.message });
    return c.json(
      {
        error: { code: e?.code ?? 'internal', message: e ? e.message : 'Internal error', ...(e?.hint ? { hint: e.hint } : {}) },
        attempts: attemptsOf(err),
      },
      status,
    );
  });

  app.get('/api/v1/health', (c) => {
    const ctx = opts.makeCtx(c.req.raw);
    return c.json({
      ok: true,
      name: 'vid2context',
      version: opts.version ?? '0.1.0',
      runtime: ctx.runtime,
      formats: Object.values(formatters).map((f) => ({ id: f.id, description: f.description, mimeType: f.mimeType })),
      // Names of env vars only; values are never returned.
      providers: opts.registry.health(ctx.env),
    });
  });

  app.get('/api/v1/context', async (c) => {
    const ctx = opts.makeCtx(c.req.raw);
    const context = await getVideoContext(
      opts.registry,
      readUrl(c.req.query('url')),
      { mode: readMode(c.req.query('mode')), language: c.req.query('lang') || undefined },
      ctx,
    );
    return c.json(context);
  });

  app.get('/api/v1/transcript', async (c) => {
    const ctx = opts.makeCtx(c.req.raw);
    const format = c.req.query('format') ?? 'text';
    const formatter = formatters[format];
    if (!formatter) throw badRequest(`Unknown format "${format}".`, `Available formats: ${Object.keys(formatters).join(', ')}.`);
    const timestamps = ['1', 'true', 'yes'].includes(c.req.query('timestamps') ?? '');
    const context = await getVideoContext(
      opts.registry,
      readUrl(c.req.query('url')),
      { mode: readMode(c.req.query('mode')), language: c.req.query('lang') || undefined },
      ctx,
    );
    return c.body(render(context, format, { timestamps }), 200, { 'content-type': formatter.mimeType });
  });

  app.notFound((c) => c.json({ error: { code: 'not-found', message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

  return app;
}
