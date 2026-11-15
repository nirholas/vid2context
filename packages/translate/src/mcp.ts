/**
 * MCP tool for the translate package. Item 44 (or the integration pass) calls
 * registerTranslateTools(server, deps) from createServer:
 *
 *   translate_transcript   a video's transcript in another language
 *
 * Failures are tool results with isError and the standard JSON error body,
 * never protocol errors. Each call gets its own Ctx carrying its abort signal.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { attemptsOf, type Ctx, formatters, type Registry, Vid2ContextError } from '@vid2context/core';
import { z } from 'zod';
import { header, type StorageSource, TRANSCRIPT_MODES, translateVideo } from './service.ts';

export interface TranslateToolDeps {
  registry: Registry;
  ctx: Ctx;
  /** Saved contexts: the source transcript is read from and saved here. Omitted: the registry's enabled storage provider, if any. */
  storage?: StorageSource;
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

function formatIds(): [string, ...string[]] {
  return Object.keys(formatters) as [string, ...string[]];
}

export function registerTranslateTools(server: McpServer, deps: TranslateToolDeps): void {
  server.registerTool(
    'translate_transcript',
    {
      title: 'Translate transcript',
      description:
        "A video's transcript in another language, with every segment and timestamp kept. Free first: the transcript as is when it is already in that language, " +
        "then the platform's own track or machine translation (YouTube translated captions), then LLM translation on the free-first rung chain. " +
        'The source transcript is saved unchanged; the translation is an added layer. ' +
        'Text output starts with a header naming the video and how it was translated; other formats come with a second content block reporting the path used and the attempts. ' +
        'Costs about as many tokens as the transcript itself (about 12k per hour of speech).',
      inputSchema: {
        url: z.string().min(1).describe('Video URL (YouTube and more), a YouTube video id, or a local media file path'),
        language: z.string().min(1).describe('Target language, BCP-47 (en, de, pt-BR)'),
        format: z
          .enum(formatIds())
          .optional()
          .describe(
            `Output format: ${Object.keys(formatters).join(', ')}. Default text. json returns the full result, source transcript included`,
          ),
        timestamps: z.boolean().optional().describe('Prefix lines with [m:ss] where the format allows. Default false'),
        mode: z
          .enum(TRANSCRIPT_MODES)
          .optional()
          .describe(
            'How to get the source transcript: auto (captions, then speech-to-text), captions, stt or video. Default auto',
          ),
        llm: z
          .boolean()
          .optional()
          .describe(
            "Allow LLM translation when the platform has no track in the language. Default true; false uses only the platform's tracks",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args, extra) => {
      try {
        const r = await translateVideo(
          args.url,
          { language: args.language, format: args.format, timestamps: args.timestamps, mode: args.mode, llm: args.llm },
          { registry: deps.registry, ctx: { ...deps.ctx, signal: extra.signal ?? deps.ctx.signal }, storage: deps.storage },
        );
        if (r.formatter.id === 'json') return { content: [{ type: 'text', text: JSON.stringify(r.json, null, 2) }] };
        if (r.formatter.id === 'text') return { content: [{ type: 'text', text: header(r.context, r.summary) + r.body }] };
        return {
          content: [
            { type: 'text', text: r.body },
            { type: 'text', text: JSON.stringify(r.summary, null, 2) },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
