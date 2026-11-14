#!/usr/bin/env -S npx tsx
/**
 * Writes integrations/chatgpt/gpt-action.openapi.json: the OpenAPI 3.1 schema
 * a custom GPT Action imports to call a vid2context HTTP server. The server
 * URL is a required argument because every deployment has its own host, so
 * no host is ever committed:
 *
 *   npx tsx integrations/chatgpt/src/action.ts --server https://your-host
 *
 * Routes and shapes follow docs/contracts/http-api.md. Each summary says
 * whether the contract lists the route as implemented or planned, so a GPT
 * pointed at an older server knows which calls may answer 404.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vid2ContextError } from '@vid2context/core';
import { DESCRIPTION, REPO_URL, TITLE } from '@vid2context/discovery';

export const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'gpt-action.openapi.json');

const urlParam = {
  name: 'url',
  in: 'query',
  required: true,
  description: 'Video URL (YouTube and more) or a YouTube video id.',
  schema: { type: 'string' },
};
const langParam = {
  name: 'lang',
  in: 'query',
  required: false,
  description: 'Preferred transcript language, BCP-47 (en, de, pt-BR).',
  schema: { type: 'string' },
};
const formatParam = {
  name: 'format',
  in: 'query',
  required: false,
  description: 'Output format id. text (default) or markdown are best for reading.',
  schema: { type: 'string', default: 'text' },
};
const timestampsParam = {
  name: 'timestamps',
  in: 'query',
  required: false,
  description: 'true prefixes each line with [m:ss] so answers can cite moments. Always pass true.',
  schema: { type: 'string', enum: ['true', 'false'], default: 'true' },
};

const errorResponse = {
  description: 'Error. error.hint says how to recover; attempts lists every provider tried.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Stable code, for example not-found, no-transcript, blocked, rate-limited.' },
              message: { type: 'string' },
              hint: { type: 'string' },
            },
            required: ['code', 'message'],
          },
          attempts: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['error'],
      },
    },
  },
};

const errors = { '400': errorResponse, '404': errorResponse, '422': errorResponse, '429': errorResponse, '503': errorResponse };

const textResponse = (description: string) => ({
  description,
  content: { 'text/plain': { schema: { type: 'string' } } },
});

const anyObject = { type: 'object', additionalProperties: true };

/** The paths this schema covers, in order. Exported for the test. */
export const ACTION_PATHS = ['/api/v1/metadata', '/api/v1/outline', '/api/v1/transcript', '/api/v1/section', '/api/v1/search', '/api/v1/pack'];

export function buildActionSchema(server: string): Record<string, unknown> {
  let parsed: URL;
  try {
    parsed = new URL(server);
  } catch {
    throw new Vid2ContextError('bad-request', `Not a URL: ${server}`, {
      hint: 'Pass the base URL of your vid2context server, for example --server https://your-host (without /api/v1).',
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new Vid2ContextError('bad-request', `GPT Actions need an https server, got ${parsed.protocol}//`, {
      hint: 'Serve vid2context over https (Cloudflare Workers or a tunnel) and pass that URL.',
    });
  }
  if (parsed.pathname.replace(/\/+$/, '').endsWith('/api/v1')) {
    throw new Vid2ContextError('bad-request', 'Pass the server root, not the /api/v1 path.', {
      hint: `Use --server ${parsed.origin}`,
    });
  }
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;

  return {
    openapi: '3.1.0',
    info: {
      title: TITLE,
      version: '1.0.0',
      description: `${DESCRIPTION} Read-only routes for a ChatGPT custom GPT Action. Source: ${REPO_URL}`,
    },
    servers: [{ url: base }],
    components: {
      schemas: {},
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/v1/metadata': {
        get: {
          operationId: 'getMetadata',
          summary: 'Video metadata: title, channel, duration, chapters (planned route)',
          description: 'Title, channel, description, duration, chapters and tags. Cheap: call it first to see how long a video is.',
          parameters: [urlParam],
          responses: { '200': { description: 'VideoMetadata', content: { 'application/json': { schema: anyObject } } }, ...errors },
        },
      },
      '/api/v1/outline': {
        get: {
          operationId: 'getOutline',
          summary: 'Chapters with estimated tokens per chapter (planned route)',
          description: 'Metadata, chapters and estimated tokens per chapter, so you fetch only the sections you need. Use before reading long videos.',
          parameters: [urlParam],
          responses: {
            '200': {
              description: '{ metadata, chapters, totalTokens }',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      metadata: anyObject,
                      chapters: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: { title: { type: 'string' }, startSec: { type: 'number' }, tokens: { type: 'number' } },
                        },
                      },
                      totalTokens: { type: 'number' },
                    },
                  },
                },
              },
            },
            ...errors,
          },
        },
      },
      '/api/v1/transcript': {
        get: {
          operationId: 'getTranscript',
          summary: 'Full transcript with [m:ss] timestamps (implemented)',
          description: 'The whole transcript, about 12k tokens per hour of speech. For long videos prefer getOutline, then getSection.',
          parameters: [
            urlParam,
            formatParam,
            timestampsParam,
            langParam,
            {
              name: 'mode',
              in: 'query',
              required: false,
              description: 'auto (default), captions, stt or video.',
              schema: { type: 'string', enum: ['auto', 'captions', 'stt', 'video'], default: 'auto' },
            },
          ],
          responses: { '200': textResponse('The rendered transcript'), ...errors },
        },
      },
      '/api/v1/section': {
        get: {
          operationId: 'getSection',
          summary: 'One time range or chapter of a transcript (planned route)',
          description: 'A slice of the transcript: from and to in seconds or m:ss, or a chapter index from getOutline.',
          parameters: [
            urlParam,
            { name: 'from', in: 'query', required: false, description: 'Start, in seconds or m:ss.', schema: { type: 'string' } },
            { name: 'to', in: 'query', required: false, description: 'End, in seconds or m:ss.', schema: { type: 'string' } },
            {
              name: 'chapter',
              in: 'query',
              required: false,
              description: 'Chapter index from getOutline.',
              schema: { type: 'integer' },
            },
            formatParam,
            timestampsParam,
          ],
          responses: { '200': textResponse('The rendered slice'), ...errors },
        },
      },
      '/api/v1/search': {
        get: {
          operationId: 'searchTranscripts',
          summary: 'Search saved transcripts (planned route)',
          description: 'Full-text search over videos saved on the server. Each hit has the title, start time, text and a timestamp URL to cite.',
          parameters: [
            { name: 'q', in: 'query', required: true, description: 'Search query.', schema: { type: 'string' } },
            { name: 'collectionId', in: 'query', required: false, description: 'Limit to one collection.', schema: { type: 'string' } },
            {
              name: 'videoIds',
              in: 'query',
              required: false,
              description: 'Comma-separated video ids to limit the search to.',
              schema: { type: 'string' },
            },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 10 } },
          ],
          responses: {
            '200': {
              description: '{ hits }',
              content: { 'application/json': { schema: { type: 'object', properties: { hits: { type: 'array', items: anyObject } } } } },
            },
            ...errors,
          },
        },
      },
      '/api/v1/pack': {
        get: {
          operationId: 'getContextPack',
          summary: 'Context pack Markdown for one video (planned route)',
          description: 'One Markdown file with metadata, chapters and transcript sized for a token budget, plus citation instructions.',
          parameters: [urlParam],
          responses: { '200': { description: 'The context pack', content: { 'text/markdown': { schema: { type: 'string' } } } }, ...errors },
        },
      },
    },
  };
}

export function run(argv: string[]): string {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const server = flag('--server');
  if (!server) {
    throw new Vid2ContextError('bad-request', 'Missing --server.', {
      hint: 'Run: npx tsx integrations/chatgpt/src/action.ts --server https://your-host',
    });
  }
  const out = flag('--out') ?? OUTPUT;
  writeFileSync(out, `${JSON.stringify(buildActionSchema(server), null, 2)}\n`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const out = run(process.argv.slice(2));
    console.error(`Wrote ${out}. In the GPT editor open Actions, import it, then set Authentication to API key, Bearer.`);
  } catch (err) {
    const e = err instanceof Vid2ContextError ? err : undefined;
    console.error(`error${e ? ` (${e.code})` : ''}: ${err instanceof Error ? err.message : String(err)}`);
    if (e?.hint) console.error(`hint: ${e.hint}`);
    process.exitCode = 1;
  }
}
