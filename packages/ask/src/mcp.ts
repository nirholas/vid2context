/**
 * The MCP `ask` tool. Item 44 (or the integration pass) calls
 * registerAskTools(server, deps) from createServer.
 *
 * Returns the answer with its `[n]` markers and a source list where every
 * cited number is a timestamp link. Failures are tool results with isError
 * and the standard JSON error body, never protocol errors.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  attemptsOf,
  type Ctx,
  formatTimestamp,
  MemoryStorage,
  type Registry,
  type Storage,
  Vid2ContextError,
} from '@vid2context/core';
import { z } from 'zod';
import { ask, LIMITS } from './engine.ts';
import type { AskResult } from './types.ts';

export interface AskToolDeps {
  registry: Registry;
  ctx: Ctx;
  /** The library. Omitted: the registry's enabled storage provider, else a process-wide MemoryStorage. */
  storage?: Storage | null | ((ctx: Ctx) => Promise<Storage | null>);
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function toolError(err: unknown): ToolResult {
  const e = err instanceof Vid2ContextError ? err : undefined;
  const payload = {
    error: {
      code: e?.code ?? 'internal',
      message: err instanceof Error ? err.message : String(err),
      ...(e?.hint ? { hint: e.hint } : {}),
    },
    attempts: attemptsOf(err),
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

/** The answer followed by one line per cited source: `[n] Title @ m:ss <url>` and the supporting quote. */
export function renderAnswer(r: AskResult): string {
  const lines = [r.answer, ''];
  if (r.citations.length > 0) {
    lines.push('Sources:');
    for (const c of r.citations) {
      const at = formatTimestamp(c.startSec);
      lines.push(`[${c.n}] ${c.title} @ ${at}${c.url ? ` ${c.url}` : ''}${c.quote ? `\n    "${c.quote}"` : ''}`);
    }
  } else {
    lines.push('No sources were cited.');
  }
  if (r.unverified.length > 0)
    lines.push('', `Removed citations that matched no source: ${r.unverified.map((n) => `[${n}]`).join(' ')}`);
  lines.push('', `Answered by ${r.rung}.`);
  return lines.join('\n');
}

export function registerAskTools(server: McpServer, deps: AskToolDeps): void {
  let fallback: MemoryStorage | undefined;
  const storageFor = async (ctx: Ctx): Promise<Storage> => {
    const s = deps.storage;
    const opened = s === undefined ? await deps.registry.openStorage(ctx) : typeof s === 'function' ? await s(ctx) : s;
    if (opened) return opened;
    fallback ??= new MemoryStorage();
    return fallback;
  };

  server.registerTool(
    'ask',
    {
      title: 'Ask videos',
      description:
        'Answer a question from the transcripts of one or more videos, or a saved collection, with server-side retrieval and the free-first LLM chain. ' +
        'Every factual sentence cites a numbered source; each source is a timestamp link to the moment that supports it. ' +
        'Says so plainly when the videos do not cover the question. Use it when you want a cited answer without reading whole transcripts.',
      inputSchema: {
        question: z.string().min(1).max(LIMITS.questionChars).describe('The question'),
        urls: z.array(z.string().min(1)).max(LIMITS.inputs).optional().describe('Video URLs or ids like youtube:abc'),
        collection: z.string().min(1).optional().describe('A collection id'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        if (!args.urls?.length && !args.collection) {
          throw new Vid2ContextError('bad-request', 'Nothing to ground the answer in.', { hint: 'Pass urls or collection.' });
        }
        const ctx: Ctx = { ...deps.ctx, signal: extra.signal ?? deps.ctx.signal };
        const result = await ask(
          deps.registry,
          {
            question: args.question,
            ...(args.urls ? { inputs: args.urls } : {}),
            ...(args.collection ? { collectionId: args.collection } : {}),
            storage: await storageFor(ctx),
          },
          ctx,
        );
        return { content: [{ type: 'text', text: renderAnswer(result) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
