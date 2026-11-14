/**
 * MCP tool `find_duplicates`. Item 44 (or the integration pass) calls
 * registerDedupeTools from createServer; this package never edits packages/mcp.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { attemptsOf, type Ctx, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { z } from 'zod';
import { duplicatesReport } from './load.ts';

export interface DedupeToolDeps {
  registry: Registry;
  ctx: Ctx;
  /** The library, for `collection` and as a cache. A function is called once per tool call with that call's Ctx. */
  storage?: Storage | ((ctx: Ctx) => Promise<Storage>) | null;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

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

export function registerDedupeTools(server: McpServer, deps: DedupeToolDeps): void {
  server.registerTool(
    'find_duplicates',
    {
      title: 'Find reuploads and clips',
      description:
        'Compare the transcripts of several videos and group reuploads (the same video uploaded again) and clips (an excerpt of a longer video, ' +
        'with the [m:ss] where it starts in the original and the range it covers). Use it before writing a brief across many videos: ' +
        'count each group once (representativeOf maps every video to its original), or a clip agreeing with its own source looks like consensus. ' +
        'Related pairs share passages without being copies. Works on transcripts only; re-dubbed or translated reuploads are not detected.',
      inputSchema: {
        urls: z.array(z.string().min(1)).optional().describe('Video URLs or ids; playlists and channels are expanded'),
        collection: z.string().min(1).optional().describe('A saved collection id'),
      },
    },
    async (args, extra) => {
      const ctx: Ctx = { ...deps.ctx, signal: extra.signal ?? deps.ctx.signal };
      try {
        const storage = typeof deps.storage === 'function' ? await deps.storage(ctx) : (deps.storage ?? null);
        const report = await duplicatesReport(
          { inputs: args.urls, collectionId: args.collection },
          { registry: deps.registry, storage },
          ctx,
        );
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
