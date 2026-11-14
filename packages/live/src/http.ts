/**
 * HTTP route `GET /live?url=&maxMinutes=` (docs/contracts/http-api.md, wave 2)
 * as a Hono sub-app. Item 46, or the integration pass, mounts it under
 * /api/v1 from the Node entry (it needs ffmpeg). The response is
 * `text/event-stream` with `segment`, `status`, `done` and `error` events,
 * each carrying one JSON object. Closing the connection stops the watcher.
 *
 * Optional extras beyond the contract: `lang` (spoken language) and
 * `fromSequence` (resume after a restart).
 */
import { attemptsOf, type Ctx, type Registry, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AudioExtractor, LiveDeps } from './types.ts';
import { watchLive } from './watch.ts';

export const LIVE_HTTP_DEFAULT_MINUTES = 10;
export const LIVE_HTTP_MAX_MINUTES = 240;

export interface LiveRouteDeps {
  registry: Registry;
  /** Build a Ctx for one request (env, fetch, logger, the request's abort signal). */
  makeCtx: (req: Request) => Ctx;
  /** ffmpeg-backed extractor from '@vid2context/live/node'. Without it the stream answers with a `no-provider` error event. */
  extractAudio?: AudioExtractor;
  /** Waits between playlist polls; defaults to a real timer. */
  sleep?: LiveDeps['sleep'];
}

function errorBody(err: unknown) {
  const e = err instanceof Vid2ContextError ? err : undefined;
  return {
    code: e?.code ?? 'internal',
    message: e ? e.message : 'Internal error',
    ...(e?.hint ? { hint: e.hint } : {}),
    attempts: attemptsOf(err),
  };
}

function badRequest(message: string, hint: string) {
  return { error: { code: 'bad-request', message, hint }, attempts: [] };
}

export function liveRoutes(deps: LiveRouteDeps): Hono {
  const app = new Hono();

  app.get('/live', (c) => {
    const url = c.req.query('url');
    if (!url) return c.json(badRequest('Missing the url query parameter.', 'Pass ?url=<live YouTube or .m3u8 URL>.'), 400);
    const rawMinutes = c.req.query('maxMinutes');
    const minutes = rawMinutes === undefined || rawMinutes === '' ? LIVE_HTTP_DEFAULT_MINUTES : Number(rawMinutes);
    if (!(minutes > 0))
      return c.json(badRequest(`maxMinutes "${rawMinutes}" is not a positive number.`, 'Omit it for 10 minutes.'), 400);
    const rawFrom = c.req.query('fromSequence');
    const fromSequence = rawFrom === undefined || rawFrom === '' ? undefined : Number(rawFrom);
    if (fromSequence !== undefined && !(Number.isInteger(fromSequence) && fromSequence >= 0)) {
      return c.json(
        badRequest(`fromSequence "${rawFrom}" is not a media sequence number.`, 'Pass the resumeSequence of the last event.'),
        400,
      );
    }
    const language = c.req.query('lang') || undefined;
    const ctx = deps.makeCtx(c.req.raw);

    return streamSSE(c, async (stream) => {
      const closed = new AbortController();
      stream.onAbort(() => closed.abort(new DOMException('Client disconnected', 'AbortError')));
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, closed.signal]) : closed.signal;
      try {
        const events = watchLive(
          url,
          { maxMinutes: Math.min(minutes, LIVE_HTTP_MAX_MINUTES), language, fromSequence, signal },
          { registry: deps.registry, ctx: { ...ctx, signal }, extractAudio: deps.extractAudio, sleep: deps.sleep },
        );
        for await (const e of events) {
          if (stream.aborted) break;
          const { type, ...data } = e;
          await stream.writeSSE({ event: type, data: JSON.stringify(data) });
        }
      } catch (err) {
        if (!(err instanceof Vid2ContextError))
          ctx.log.error('live stream failed', { message: err instanceof Error ? err.message : String(err) });
        if (!stream.aborted) await stream.writeSSE({ event: 'error', data: JSON.stringify(errorBody(err)) });
      }
    });
  });

  return app;
}
