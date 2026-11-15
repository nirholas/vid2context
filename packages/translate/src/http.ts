/**
 * HTTP route for the translate package, as a Hono sub-app. Item 46 (or the
 * integration pass) mounts it: `app.route('/api/v1', translateRoutes(deps))`.
 *
 *   GET /translate?url=&lang=&format=&timestamps=&mode=&refresh=&llm=
 *
 * Returns the translation rendered by the chosen formatter with its mimeType
 * (default text). format=json returns the full result: how it was translated,
 * the attempts, the translated VideoContext and the untouched source
 * transcript. Errors are thrown as Vid2ContextError and handled by the main
 * app's onError, so they get the standard body and status.
 */
import { type Ctx, type Registry, type Storage, type TranscriptMode, Vid2ContextError } from '@vid2context/core';
import { Hono } from 'hono';
import { TRANSCRIPT_MODES, translateVideo } from './service.ts';

export interface RouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  /** Saved contexts: the source transcript is read from and saved here. Omitted: the registry's enabled storage provider, if any. */
  storage?: (ctx: Ctx) => Promise<Storage | null>;
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

const TRUE = new Set(['1', 'true', 'yes']);
const FALSE = new Set(['0', 'false', 'no']);

function flag(v: string | undefined, name: string): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  const s = v.toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  throw bad(`${name} must be 1 or 0, got "${v.slice(0, 20)}".`, `Pass ${name}=1 or ${name}=0, or leave it out.`);
}

function mode(v: string | undefined): TranscriptMode | undefined {
  if (v === undefined || v === '') return undefined;
  if ((TRANSCRIPT_MODES as readonly string[]).includes(v)) return v as TranscriptMode;
  throw bad(`Unknown mode "${v.slice(0, 20)}".`, `Use one of: ${TRANSCRIPT_MODES.join(', ')}.`);
}

export function translateRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get('/translate', async (c) => {
    const input = c.req.query('url') || c.req.query('input');
    if (!input) throw bad('Missing the url query parameter.', 'Pass ?url=<video URL>&lang=<language code>.');
    const lang = c.req.query('lang');
    if (!lang) throw bad('Missing the lang query parameter.', 'Pass the target language, for example lang=de.');
    const ctx = deps.makeCtx(c.req.raw);
    const r = await translateVideo(
      input,
      {
        language: lang,
        format: c.req.query('format') || undefined,
        timestamps: flag(c.req.query('timestamps'), 'timestamps'),
        mode: mode(c.req.query('mode')),
        refresh: flag(c.req.query('refresh'), 'refresh'),
        llm: flag(c.req.query('llm'), 'llm'),
      },
      { registry: deps.registry, ctx, storage: deps.storage },
    );
    const headers = {
      'x-translated-via': r.summary.via,
      'x-translation-producer': r.summary.producer,
      'x-source-language': r.summary.source.language,
    };
    if (r.formatter.id === 'json') return c.json(r.json, 200, headers);
    return c.body(r.body, 200, { ...headers, 'content-type': r.formatter.mimeType });
  });

  return app;
}
