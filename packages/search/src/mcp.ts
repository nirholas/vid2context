/**
 * MCP tool for search. Item 44 (or the integration pass) calls
 * registerSearchTools(server, deps) from createServer:
 *
 *   search_transcript  { query, collection?, urls?, limit?, rerank? }
 *
 * Searches the saved library (or one collection, or the given videos, which
 * are fetched and saved first when they are not in the library yet) and
 * returns hits with title, [m:ss], highlighted text and a timestamp URL.
 * Failures are tool results with isError and the standard JSON error body,
 * never protocol errors. Each call gets its own Ctx carrying its abort signal.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { attemptsOf, type Ctx, getVideoContext, type Registry, Vid2ContextError } from '@vid2context/core';
import { z } from 'zod';
import { type EngineSettings, engineFor, renderResults, resolveStorage, type StorageSource } from './shared.ts';

export interface SearchToolDeps {
  registry: Registry;
  ctx: Ctx;
  /** The library backend. Omitted: the registry's enabled storage provider, else a process-local MemoryStorage. */
  storage?: StorageSource;
  /** Engine settings (embedModel, keyword backend, fusion, chunking). */
  search?: EngineSettings;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const MAX_URLS = 20;

function toolError(err: unknown): ToolResult {
  const e = err instanceof Vid2ContextError ? err : undefined;
  const payload = {
    error: e?.code ?? 'internal',
    message: err instanceof Error ? err.message : String(err),
    ...(e?.hint ? { hint: e.hint } : {}),
    attempts: attemptsOf(err),
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

export function registerSearchTools(server: McpServer, deps: SearchToolDeps): void {
  server.registerTool(
    'search_transcript',
    {
      title: 'Search transcripts',
      description:
        'Find where something is said across saved video transcripts, instead of reading whole transcripts (about 12k tokens per hour). ' +
        'Hybrid search: keyword matching for exact names and model numbers, plus meaning-based matching for paraphrases (when an embedding model is available). ' +
        'Returns the best time ranges with title, [m:ss], highlighted text and a timestamp link. ' +
        'Syntax: "exact phrase" must appear, -word excludes. Scope with collection (a collection id) or urls (videos are fetched and saved first if needed).',
      inputSchema: {
        query: z.string().min(1).describe('What to look for. "quoted phrases" are required, -word excludes a word'),
        collection: z.string().min(1).optional().describe('Only search this collection (its id)'),
        urls: z.array(z.string().min(1)).min(1).max(MAX_URLS).optional().describe('Only search these videos'),
        limit: z.number().int().min(1).max(50).optional().describe('Hits to return. Default 10'),
        rerank: z.boolean().optional().describe('Rerank the top results with a free LLM. Slower; default false'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const ctx: Ctx = { ...deps.ctx, signal: extra.signal ?? deps.ctx.signal };
        const storage = await resolveStorage(deps.registry, deps.storage, ctx);
        let videoIds: string[] | undefined;
        if (args.urls) {
          videoIds = [];
          for (const url of args.urls) {
            const { ref } = deps.registry.resolve(url);
            if (ref.kind !== 'video') {
              throw new Vid2ContextError('unsupported-input', `"${url}" is a ${ref.kind}, not a single video.`, {
                hint: 'Pass video URLs, or add the list to a collection and search with collection.',
              });
            }
            if (!(await storage.getContext(ref.id))) await getVideoContext(deps.registry, url, { storage }, ctx);
            videoIds.push(ref.id);
          }
        }
        const engine = engineFor(deps.registry, storage, ctx, deps.search);
        const result = await engine.search(
          { query: args.query, collectionId: args.collection, videoIds, limit: args.limit, rerank: args.rerank },
          { ctx },
        );
        return { content: [{ type: 'text', text: renderResults(result) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
