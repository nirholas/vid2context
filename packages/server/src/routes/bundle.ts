/**
 * GET and POST /bundle: a .zip with every file an agent could want for one or
 * many videos (docs/prompts/SHARED-CONTRACTS.md section 2), built by core
 * `buildBundle` and streamed as it is zipped.
 */
import { type Bundle, buildBundle } from '@vid2context/core';
import { type Context, Hono } from 'hono';
import {
  optionalBoolean,
  optionalPositiveInt,
  optionalString,
  optionalStrings,
  readFlag,
  readInt,
  readJsonObject,
  readList,
  readMode,
  readUrl,
} from '../http-util.ts';
import { json, P } from '../openapi.ts';
import type { AppEnv, RouteDeps } from '../types.ts';

const ZIP = { 'application/zip': { type: 'string', format: 'binary' } };
const MAX_TOKENS = 2_000_000;

function zipResponse(c: Context<AppEnv>, bundle: Bundle): Response {
  // The bundle root is a slug (a-z, 0-9, hyphens), so the filename needs no quoting beyond the quotes.
  return c.body(bundle.zip(), 200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${bundle.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    'cache-control': 'no-store',
  });
}

export function bundleRoutes({ services, docs }: RouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  docs.add({
    method: 'get',
    path: '/api/v1/bundle',
    summary: 'A .zip bundle for one video: context.md (the pack), transcripts in every format, metadata, manifest.',
    tags: ['bundle'],
    params: [
      P.url,
      { name: 'formats', description: 'Comma-separated formatter ids to include (default: all). context.md is always written.' },
      { name: 'comments', description: '1 to fetch comments and write comments.md.' },
      { name: 'maxTokens', description: 'Token budget for context.md.', schema: { type: 'integer', minimum: 1 } },
      P.mode,
      P.lang,
    ],
    responses: { '200': { description: 'The zip (Content-Disposition: attachment).', content: ZIP } },
  });
  app.get('/bundle', async (c) => {
    const comments = readFlag(c.req.query('comments'));
    const maxTokens = readInt('maxTokens', c.req.query('maxTokens'), { max: MAX_TOKENS });
    const formats = readList(c.req.query('formats'));
    const context = await services.loadContext(
      readUrl(c.req.query('url')),
      {
        mode: readMode(c.req.query('mode')),
        language: c.req.query('lang') || undefined,
        ...(comments ? { comments: true } : {}),
      },
      services.ctxFor(c.req.raw),
    );
    return zipResponse(c, await buildBundle([context], { formats, comments, maxTokens }));
  });

  docs.add({
    method: 'post',
    path: '/api/v1/bundle',
    summary: 'A .zip bundle for many videos (inputs, playlists expanded, and/or a collection).',
    tags: ['bundle'],
    body: {
      content: json({
        type: 'object',
        properties: {
          inputs: { type: 'array', items: { type: 'string' } },
          collectionId: { type: 'string' },
          formats: { type: 'array', items: { type: 'string' } },
          comments: { type: 'boolean' },
          maxTokens: { type: 'integer', minimum: 1 },
          mode: { type: 'string', enum: ['auto', 'captions', 'stt', 'video'] },
          lang: { type: 'string' },
        },
      }),
    },
    responses: { '200': { description: 'The zip (Content-Disposition: attachment).', content: ZIP } },
  });
  app.post('/bundle', async (c) => {
    const body = await readJsonObject(c);
    const comments = optionalBoolean(body, 'comments') ?? false;
    const formats = optionalStrings(body, 'formats');
    const maxTokens = optionalPositiveInt(body, 'maxTokens', MAX_TOKENS);
    const contexts = await services.loadBatch(
      { inputs: optionalStrings(body, 'inputs'), collectionId: optionalString(body, 'collectionId') },
      {
        mode: readMode(optionalString(body, 'mode')),
        language: optionalString(body, 'lang'),
        ...(comments ? { comments: true } : {}),
      },
      services.ctxFor(c.req.raw),
    );
    return zipResponse(c, await buildBundle(contexts, { formats, comments, maxTokens }));
  });

  return app;
}
