/**
 * Video routes: context, transcript, metadata, formats, items, section,
 * outline, comments and pack. Every route goes through Services, so uploads,
 * single-flight, the library cache and the public-mode policy apply alike.
 */
import {
  expandInput,
  formatters,
  getSection,
  limits,
  outlineForApi,
  parseTimeArg,
  render,
  renderMany,
  type SectionSelector,
  Vid2ContextError,
} from '@vid2context/core';
import { ATTRIBUTION_HEADER, SPONSORBLOCK_ATTRIBUTION, skipQueryOption } from '@vid2context/skips';
import { type Context, Hono } from 'hono';
import { badRequest } from '../errors.ts';
import {
  jsonWithEtag,
  optionalPositiveInt,
  optionalString,
  optionalStrings,
  readFlag,
  readFormat,
  readInt,
  readJsonObject,
  readMode,
  readUrl,
} from '../http-util.ts';
import { json, P, ref, textResponse } from '../openapi.ts';
import type { AppEnv, RouteDeps } from '../types.ts';
import { isUploadInput } from '../uploads.ts';

const V = '/api/v1';
const MAX_TOKENS = 2_000_000;

export function videoRoutes({ services, docs }: RouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const load = (c: Context<AppEnv>) =>
    services.loadContext(
      readUrl(c.req.query('url')),
      {
        mode: readMode(c.req.query('mode')),
        language: c.req.query('lang') || undefined,
        refresh: readFlag(c.req.query('refresh')),
      },
      services.ctxFor(c.req.raw),
    );

  docs.add({
    method: 'get',
    path: `${V}/context`,
    summary: 'Full VideoContext: metadata, timed transcript, optional visual notes and comments, and attempts.',
    tags: ['videos'],
    params: [P.url, P.mode, P.lang, { name: 'refresh', description: '1 to ignore the library copy and rebuild.' }],
    responses: {
      '200': {
        description: 'The VideoContext.',
        content: json(ref('VideoContext')),
        headers: { ETag: 'Version of the body; send it back as If-None-Match.' },
      },
      '304': { description: 'Not modified (If-None-Match matched).' },
    },
  });
  app.get('/context', async (c) => jsonWithEtag(c, await load(c)));

  docs.add({
    method: 'get',
    path: `${V}/transcript`,
    summary: 'The transcript rendered by a formatter.',
    description:
      'skip= removes SponsorBlock segments (sponsor, selfpromo, ...; 1 for the defaults) from a copy of the transcript; the raw transcript stays stored. translate=1 asks for LLM translation into lang when the platform has no track in that language.',
    tags: ['videos'],
    params: [
      P.url,
      P.format,
      P.timestamps,
      P.mode,
      P.lang,
      { name: 'skip', description: 'Comma-separated SponsorBlock categories to remove, or 1 for the defaults.' },
      { name: 'translate', description: '1 to allow LLM translation into lang.' },
    ],
    responses: { '200': textResponse() },
  });
  app.get('/transcript', async (c) => {
    const ctx = services.ctxFor(c.req.raw);
    const formatter = readFormat(c.req.query('format'));
    if (readFlag(c.req.query('translate'))) {
      throw badRequest(
        'This server has no translation layer, so translate=1 is not available.',
        'Leave out translate=1 to get the transcript in its spoken language, or pass lang=xx to pick a caption track the platform already has.',
      );
    }
    const context = await load(c);
    const skip = c.req.query('skip');
    const transcript = skip ? await skipQueryOption(context.transcript, ctx, skip) : context.transcript;
    const headers: Record<string, string> = { 'content-type': formatter.mimeType };
    if (transcript.producer.endsWith('+skips')) headers[ATTRIBUTION_HEADER] = SPONSORBLOCK_ATTRIBUTION;
    const timestamps = readFlag(c.req.query('timestamps'));
    return c.body(render({ ...context, transcript }, formatter.id, { timestamps }), 200, headers);
  });

  docs.add({
    method: 'get',
    path: `${V}/metadata`,
    summary: 'Video metadata only (title, channel, duration, chapters), without fetching a transcript.',
    tags: ['videos'],
    params: [P.url],
    responses: { '200': { description: 'VideoMetadata.', content: json(ref('VideoMetadata')) } },
  });
  app.get('/metadata', async (c) => c.json(await services.loadMetadata(readUrl(c.req.query('url')), services.ctxFor(c.req.raw))));

  docs.add({
    method: 'get',
    path: `${V}/formats`,
    summary: 'Output formats this server can render.',
    tags: ['videos'],
    responses: {
      '200': {
        description: 'Formats.',
        content: json({
          type: 'object',
          properties: { formats: { type: 'array', items: ref('Format') } },
          required: ['formats'],
        }),
      },
    },
  });
  app.get('/formats', (c) =>
    c.json({
      formats: Object.values(formatters).map((f) => ({
        id: f.id,
        description: f.description,
        mimeType: f.mimeType,
        extension: f.extension,
      })),
    }),
  );

  docs.add({
    method: 'get',
    path: `${V}/items`,
    summary: 'Expand a playlist, channel, feed or page into video refs. A single video returns itself.',
    tags: ['videos'],
    params: [P.url, P.limit('Most items to return. Default and maximum: VID2CONTEXT_MAX_PLAYLIST_ITEMS (500).')],
    responses: {
      '200': {
        description: 'Video refs.',
        content: json({ type: 'object', properties: { items: { type: 'array', items: ref('VideoRef') } }, required: ['items'] }),
      },
    },
  });
  app.get('/items', async (c) => {
    const ctx = services.ctxFor(c.req.raw);
    const input = readUrl(c.req.query('url'));
    const max = limits(ctx.env).maxPlaylistItems;
    const limit = readInt('limit', c.req.query('limit'), { max }) ?? max;
    services.checkInput(input, ctx);
    if (isUploadInput(input)) return c.json({ items: [(await services.loadMetadata(input, ctx)).ref] });
    return c.json({ items: await expandInput(services.registry, input, ctx, { limit }) });
  });

  docs.add({
    method: 'get',
    path: `${V}/section`,
    summary: 'One time range or chapter of the transcript, rendered by a formatter.',
    tags: ['videos'],
    params: [
      P.url,
      { name: 'from', description: 'Start: seconds (754), m:ss (12:34) or h:mm:ss.' },
      { name: 'to', description: 'End (exclusive), same forms as from.' },
      { name: 'chapter', description: 'An outline section index (0-based) or a chapter title.' },
      P.format,
      P.timestamps,
      P.mode,
      P.lang,
    ],
    responses: { '200': textResponse() },
  });
  app.get('/section', async (c) => {
    const formatter = readFormat(c.req.query('format'));
    const from = c.req.query('from');
    const to = c.req.query('to');
    const chapter = c.req.query('chapter');
    if (!from && !to && !chapter)
      throw badRequest('Pass from, to or chapter.', 'For example ?from=1:00&to=2:30, or ?chapter=2 (see GET /api/v1/outline).');
    const sel: SectionSelector = {
      ...(from ? { fromSec: parseTimeArg(from) } : {}),
      ...(to ? { toSec: parseTimeArg(to) } : {}),
      ...(chapter ? { chapter: /^\d+$/.test(chapter.trim()) ? Number(chapter) : chapter } : {}),
    };
    const section = getSection(await load(c), sel);
    return c.body(render(section, formatter.id, { timestamps: readFlag(c.req.query('timestamps')) }), 200, {
      'content-type': formatter.mimeType,
    });
  });

  docs.add({
    method: 'get',
    path: `${V}/outline`,
    summary: 'Chapters (or five-minute sections) with token estimates, so an agent can pick what to fetch.',
    tags: ['videos'],
    params: [P.url, P.mode, P.lang],
    responses: {
      '200': {
        description: 'Outline.',
        content: json({
          type: 'object',
          properties: {
            metadata: ref('VideoMetadata'),
            chapters: {
              type: 'array',
              items: {
                allOf: [ref('Chapter'), { type: 'object', properties: { tokens: { type: 'integer' } }, required: ['tokens'] }],
              },
            },
            totalTokens: { type: 'integer' },
          },
          required: ['metadata', 'chapters', 'totalTokens'],
        }),
      },
    },
  });
  app.get('/outline', async (c) => c.json(outlineForApi(await load(c))));

  docs.add({
    method: 'get',
    path: `${V}/comments`,
    summary: 'Top comments of a video, from the source provider.',
    tags: ['videos'],
    params: [P.url, P.limit('Most comments to return (1 to 1000).')],
    responses: {
      '200': {
        description: 'Comments.',
        content: json({
          type: 'object',
          properties: { comments: { type: 'array', items: ref('Comment') } },
          required: ['comments'],
        }),
      },
    },
  });
  app.get('/comments', async (c) => {
    const ctx = services.ctxFor(c.req.raw);
    const input = readUrl(c.req.query('url'));
    const limit = readInt('limit', c.req.query('limit'), { max: 1000 });
    services.checkInput(input, ctx);
    if (isUploadInput(input)) return c.json({ comments: [] });
    const { source, ref: vref } = services.registry.resolve(input);
    if (!source.getComments) {
      throw new Vid2ContextError('no-provider', `No installed provider can fetch comments for ${source.name}.`, {
        hint: 'Comments need a source that supports them (the yt-dlp provider covers many sites).',
      });
    }
    return c.json({ comments: await source.getComments(vref, ctx, limit ? { limit } : {}) });
  });

  docs.add({
    method: 'get',
    path: `${V}/pack`,
    summary: 'The context pack for one video: one Markdown file sized for a token budget, with citation instructions.',
    tags: ['videos'],
    params: [
      P.url,
      { name: 'maxTokens', description: 'Token budget for the pack.', schema: { type: 'integer', minimum: 1 } },
      P.mode,
      P.lang,
    ],
    responses: { '200': { description: 'The pack.', content: { 'text/markdown': { type: 'string' } } } },
  });
  app.get('/pack', async (c) => {
    const maxTokens = readInt('maxTokens', c.req.query('maxTokens'), { max: MAX_TOKENS });
    const context = await load(c);
    return c.body(render(context, 'pack', maxTokens ? { maxTokens } : {}), 200, {
      'content-type': formatters.pack?.mimeType ?? 'text/markdown; charset=utf-8',
    });
  });

  docs.add({
    method: 'post',
    path: `${V}/pack`,
    summary: 'One context pack for many videos (inputs, playlists expanded, and/or a collection).',
    tags: ['videos'],
    body: {
      content: json({
        type: 'object',
        properties: {
          inputs: { type: 'array', items: { type: 'string' } },
          collectionId: { type: 'string' },
          maxTokens: { type: 'integer', minimum: 1 },
          mode: { type: 'string', enum: ['auto', 'captions', 'stt', 'video'] },
          lang: { type: 'string' },
        },
      }),
    },
    responses: { '200': { description: 'The pack.', content: { 'text/markdown': { type: 'string' } } } },
  });
  app.post('/pack', async (c) => {
    const body = await readJsonObject(c);
    const maxTokens = optionalPositiveInt(body, 'maxTokens', MAX_TOKENS);
    const contexts = await services.loadBatch(
      { inputs: optionalStrings(body, 'inputs'), collectionId: optionalString(body, 'collectionId') },
      { mode: readMode(optionalString(body, 'mode')), language: optionalString(body, 'lang') },
      services.ctxFor(c.req.raw),
    );
    const [only] = contexts;
    const text =
      only && contexts.length === 1 ? render(only, 'pack', { maxTokens }) : renderMany(contexts, 'pack', { maxTokens });
    return c.body(text, 200, { 'content-type': formatters.pack?.mimeType ?? 'text/markdown; charset=utf-8' });
  });

  return app;
}
