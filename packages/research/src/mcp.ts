/**
 * MCP tools for the research package. Item 44 (or the integration pass)
 * calls registerResearchTools(server, deps) from createServer:
 *
 *   research_videos         ranked excerpts across 1 to 10 videos
 *   list_caption_languages  caption tracks and translation targets
 *   get_key_moments         LLM-picked moments with verified timestamps
 *
 * Failures are tool results with isError and the standard JSON error body,
 * never protocol errors. Each call gets its own Ctx carrying its abort signal.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { attemptsOf, type Ctx, type Registry, Vid2ContextError } from '@vid2context/core';
import { z } from 'zod';
import type { StorageSource } from './deps.ts';
import { listCaptionLanguages } from './languages.ts';
import { keyMoments } from './moments.ts';
import { DEFAULTS, MAX_VIDEOS, renderResearch, research } from './research.ts';

export interface ResearchToolDeps {
  registry: Registry;
  ctx: Ctx;
  /** Saved contexts, used as a cache. Omitted: the registry's enabled storage provider, if any. */
  storage?: StorageSource;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));

function toolError(err: unknown): ToolResult {
  const e = err instanceof Vid2ContextError ? err : undefined;
  const payload = {
    error: e?.code ?? 'error',
    message: err instanceof Error ? err.message : String(err),
    ...(e?.hint ? { hint: e.hint } : {}),
    attempts: attemptsOf(err),
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

export function registerResearchTools(server: McpServer, deps: ResearchToolDeps): void {
  const forCall = (signal?: AbortSignal) => ({
    registry: deps.registry,
    ctx: { ...deps.ctx, signal: signal ?? deps.ctx.signal },
    storage: deps.storage,
  });

  server.registerTool(
    'research_videos',
    {
      title: 'Research videos',
      description:
        `Search 1 to ${MAX_VIDEOS} videos (or a playlist, capped at ${MAX_VIDEOS}) for a question and get only the relevant excerpts: ` +
        'ranked by BM25, each with the surrounding context, [m:ss] and a timestamp link, under a token cap. ' +
        'Use it instead of reading whole transcripts (about 12k tokens per hour of speech). ' +
        'Put exact phrases in double quotes to boost them. Lexical: if nothing matches, it lists words the videos do use so you can retry with a synonym.',
      inputSchema: {
        urls: z.array(z.string().min(1)).min(1).max(MAX_VIDEOS).describe('Video URLs, or one playlist URL'),
        query: z.string().min(1).describe('Words to look for; "quoted phrases" are boosted'),
        contextSec: z
          .number()
          .min(0)
          .max(120)
          .optional()
          .describe(`Seconds of context before and after each match. Default ${DEFAULTS.contextSec}`),
        maxExcerpts: z.number().int().min(1).max(10).optional().describe(`Excerpts per video. Default ${DEFAULTS.maxExcerpts}`),
        maxTokens: z
          .number()
          .int()
          .min(200)
          .max(20_000)
          .optional()
          .describe(`Cap on the whole result. Default ${DEFAULTS.maxTokens}`),
        format: z.enum(['text', 'json']).optional().describe('text (compact Markdown, default) or json'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const r = await research(
          args.urls,
          args.query,
          { contextSec: args.contextSec, maxExcerpts: args.maxExcerpts, maxTokens: args.maxTokens },
          forCall(extra.signal),
        );
        return args.format === 'json' ? json(r) : text(renderResearch(r));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'list_caption_languages',
    {
      title: 'List caption languages',
      description:
        'List the caption tracks a video has (language, name, creator or auto-generated) and, for YouTube, the languages YouTube can machine-translate them into. ' +
        'Call it before get_transcript to pick a language.',
      inputSchema: { url: z.string().min(1).describe('Video URL') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        return json(await listCaptionLanguages(args.url, forCall(extra.signal)));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'get_key_moments',
    {
      title: 'Get key moments',
      description:
        'The moments of a video worth jumping to, picked by the free-first LLM chain from the timestamped transcript. ' +
        'Every timestamp is checked against the real transcript (snapped within 5 seconds, dropped otherwise); the result says how many were dropped and which rung answered.',
      inputSchema: {
        url: z.string().min(1).describe('Video URL'),
        count: z.number().int().min(1).max(30).optional().describe('How many moments. Default 8'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        return json(await keyMoments(args.url, { count: args.count }, forCall(extra.signal)));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
