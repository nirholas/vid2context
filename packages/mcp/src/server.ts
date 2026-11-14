/**
 * vid2context MCP server. Tools return text; failures come back as tool
 * errors (isError) carrying the error code, hint and attempts, so the calling
 * agent can explain what went wrong or retry with another mode.
 *
 * Every tool call gets its own Ctx (a shallow copy carrying the call's abort
 * signal), so per-request caches never outlive the call.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  attemptsOf,
  type Ctx,
  formatTimestamp,
  formatters,
  getVideoContext,
  type Registry,
  render,
  type TranscriptMode,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { z } from 'zod';

export const SERVER_NAME = 'vid2context';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

export function toolError(err: unknown): ToolResult {
  const e = err instanceof Vid2ContextError ? err : undefined;
  const payload = {
    error: e?.code ?? 'error',
    message: err instanceof Error ? err.message : String(err),
    ...(e?.hint ? { hint: e.hint } : {}),
    attempts: attemptsOf(err),
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

/** A short header so the agent knows which video a transcript came from and how it was produced. */
export function contextHeader(c: VideoContext): string {
  const m = c.metadata;
  const lines = [
    `Title: ${m.title}`,
    m.channel ? `Channel: ${m.channel.name}` : undefined,
    m.ref.url ? `URL: ${m.ref.url}` : undefined,
    m.durationSec ? `Duration: ${formatTimestamp(m.durationSec)}` : undefined,
    `Transcript: ${c.transcript.origin}, ${c.transcript.language}${c.transcript.translated ? ', machine-translated' : ''} (${c.transcript.producer})`,
    m.chapters.length > 0
      ? `Chapters: ${m.chapters.map((ch) => `${formatTimestamp(ch.startSec)} ${ch.title}`).join(' | ')}`
      : undefined,
  ];
  return `${lines.filter(Boolean).join('\n')}\n\n`;
}

export function createServer(registry: Registry, ctx: Ctx, version = '0.1.0'): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version });
  const callCtx = (signal?: AbortSignal): Ctx => ({ ...ctx, signal: signal ?? ctx.signal });
  const formatIds = Object.keys(formatters) as [string, ...string[]];

  server.registerTool(
    'get_transcript',
    {
      title: 'Get video transcript',
      description:
        'Turn a video URL or local media file into a transcript. Uses creator captions, then platform auto-captions, then speech-to-text. ' +
        'Text output starts with a header (title, channel, URL, chapters) and, with timestamps, prefixes each line with [m:ss] so you can cite moments. ' +
        `Formats: ${Object.values(formatters)
          .map((f) => `${f.id} (${f.description})`)
          .join('; ')}.`,
      inputSchema: {
        url: z.string().min(1).describe('Video URL (YouTube and more) or a local file path'),
        format: z.enum(formatIds).optional().describe('Output format. Default: text'),
        timestamps: z.boolean().optional().describe('Prefix lines with timestamps. Default: true'),
        mode: z.enum(['auto', 'captions', 'stt', 'video']).optional().describe('Transcript strategy. Default: auto'),
        language: z.string().optional().describe('Preferred transcript language (BCP-47, e.g. en, de)'),
      },
    },
    async (args, extra) => {
      try {
        const context = await getVideoContext(
          registry,
          args.url,
          { mode: (args.mode ?? 'auto') as TranscriptMode, language: args.language },
          callCtx(extra.signal),
        );
        const format = args.format ?? 'text';
        const body = render(context, format, { timestamps: args.timestamps ?? true });
        return text(format === 'text' ? contextHeader(context) + body : body);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'get_metadata',
    {
      title: 'Get video metadata',
      description:
        'Title, channel, description, duration, chapters, tags and language for a video URL or local file, without fetching the transcript.',
      inputSchema: { url: z.string().min(1).describe('Video URL or local file path') },
    },
    async (args, extra) => {
      try {
        const c = callCtx(extra.signal);
        const { source, ref } = registry.resolve(args.url);
        const metadata = await source.getMetadata(ref, c);
        return text(JSON.stringify(metadata, null, 2));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  return server;
}
