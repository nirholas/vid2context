/**
 * MCP Apps tools for the vid2context MCP server. `registerAppsTools` adds
 * `open_transcript_viewer` and the UI resource it renders in
 * (`ui://vid2context/transcript-viewer`). No transport code: item 44 calls
 * this from `createServer`, and item 45 serves that same server over
 * Streamable HTTP for ChatGPT and Claude.ai.
 *
 * The tool works in every client. Hosts that support MCP Apps render the
 * viewer from `structuredContent`; the text content is the fallback, so a
 * client without MCP Apps still gets the header and the transcript.
 */
import { getUiCapability, RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Ctx, getVideoContext, type Registry, render, type Storage, type VideoContext } from '@vid2context/core';
import { contextHeader, toolError } from '@vid2context/mcp';
import { z } from 'zod';
import { toViewerData } from './context.ts';
import { VIEWER_URI } from './data.ts';
import { VIEWER_HTML } from './ui/viewer.html.ts';

export { VIEWER_URI };

/** Characters of transcript text the fallback keeps when the client renders the viewer. */
export const TEXT_FALLBACK_CHARS = 4000;

const RESOURCE_DESCRIPTION =
  'Interactive transcript viewer for one video: chapters, full-text search, clickable timestamps that open the video at that moment, and one-click citations.';

const resourceMeta = {
  ui: {
    // Copy citation uses the Clipboard API; hosts may grant it, the viewer falls back when they do not.
    permissions: { clipboardWrite: {} },
    prefersBorder: true,
  },
  // ChatGPT shows this to the model when the viewer loads, so it does not narrate the transcript again.
  'openai/widgetDescription':
    'An interactive transcript viewer is showing the video transcript with chapters, search, timestamps and citation buttons. Do not repeat the transcript; answer questions about it or cite moments as [Title @ m:ss](url).',
};

const segmentTuple = z.tuple([z.number(), z.number(), z.string()]);
const outputSchema = {
  metadata: z.object({
    id: z.string(),
    title: z.string(),
    url: z.string().optional(),
    channel: z.string().optional(),
    durationSec: z.number().optional(),
    publishedAt: z.string().optional(),
    origin: z.enum(['creator-captions', 'auto-captions', 'native-transcript', 'stt', 'video-model', 'imported']),
    language: z.string(),
    translated: z.boolean().optional(),
  }),
  chapters: z.array(z.object({ title: z.string(), startSec: z.number(), endSec: z.number().optional() })),
  segments: z.array(segmentTuple).describe('Transcript lines as [startSec, endSec, text]'),
  timestampBase: z
    .string()
    .nullable()
    .describe('Link that opens the video at a moment: replace {t} with whole seconds. Null when there is no deep link.'),
};

/**
 * The text content of the result. When the client renders the viewer, the
 * transcript text is capped (the full transcript is in the viewer and in
 * `structuredContent`); otherwise the whole timestamped transcript is sent.
 */
export function textFallback(context: VideoContext, viewerShown: boolean, maxChars = TEXT_FALLBACK_CHARS): string {
  const header = contextHeader(context);
  const body = render(context, 'text', { timestamps: true });
  if (!viewerShown || body.length <= maxChars) return header + body;
  const lines = body.split('\n');
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > maxChars && kept.length > 0) break;
    kept.push(line);
    size += line.length + 1;
  }
  const total = context.transcript.segments.length;
  return (
    header +
    kept.join('\n') +
    `\n\n[Showing the first ${kept.length} of ${lines.length} transcript lines (${total} segments). ` +
    "The full transcript is in the transcript viewer and in this result's structured content. " +
    'Use get_transcript or get_section for more text.]'
  );
}

export function registerAppsTools(server: McpServer, deps: { registry: Registry; ctx: Ctx }): void {
  const { registry, ctx } = deps;
  // The configured storage backend (if any) is the cache, opened once per server.
  let storage: Promise<Storage | null> | undefined;
  const openStorage = (): Promise<Storage | null> => {
    storage ??= registry.openStorage(ctx).catch((err: unknown) => {
      ctx.log.warn('transcript viewer: storage unavailable, continuing without cache', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    return storage;
  };

  registerAppResource(
    server,
    'vid2context transcript viewer',
    VIEWER_URI,
    { description: RESOURCE_DESCRIPTION, mimeType: RESOURCE_MIME_TYPE, _meta: resourceMeta },
    async () => ({
      contents: [{ uri: VIEWER_URI, mimeType: RESOURCE_MIME_TYPE, text: VIEWER_HTML, _meta: resourceMeta }],
    }),
  );

  registerAppTool(
    server,
    'open_transcript_viewer',
    {
      title: 'Open transcript viewer',
      description:
        'Show a video transcript in an interactive viewer (chapters, search, clickable [m:ss] timestamps, one-click citations, send selected lines to the chat) ' +
        'in clients that support MCP Apps, such as ChatGPT and Claude. The text result starts with a header (title, channel, URL, chapters); ' +
        'clients without MCP Apps get the full timestamped transcript as text.',
      inputSchema: {
        url: z.string().min(1).describe('Video URL (YouTube and more) or a local file path'),
        language: z.string().optional().describe('Preferred transcript language (BCP-47, e.g. en, de)'),
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {
        ui: { resourceUri: VIEWER_URI },
        'openai/toolInvocation/invoking': 'Loading the transcript',
        'openai/toolInvocation/invoked': 'Transcript ready',
      },
    },
    async (args, extra) => {
      try {
        const callCtx: Ctx = { ...ctx, signal: extra.signal ?? ctx.signal };
        const context = await getVideoContext(
          registry,
          args.url,
          { mode: 'auto', language: args.language, storage: await openStorage() },
          callCtx,
        );
        const ui = getUiCapability(server.server.getClientCapabilities());
        const viewerShown = Boolean(ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE));
        const data = toViewerData(context);
        return {
          content: [{ type: 'text' as const, text: textFallback(context, viewerShown) }],
          structuredContent: { ...data },
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
