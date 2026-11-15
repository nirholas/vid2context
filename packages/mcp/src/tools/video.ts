/**
 * Tools that read one video: get_transcript, get_metadata, list_formats,
 * get_outline, get_section and get_comments.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type Comment,
  type Ctx,
  estimateTokens,
  formatTimestamp,
  formatters,
  getSection,
  getVideoContext,
  outlineForApi,
  parseTimeArg,
  type RecoveryContext,
  type Registry,
  render,
  type SectionInfo,
  type Storage,
  type TranscriptMode,
  timestampUrl,
  transcriptOutline,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { z } from 'zod';
import { callCtx, contextHeader, structured, text, toolError } from '../shared.ts';

export interface ToolDeps {
  registry: Registry;
  ctx: Ctx;
  storage: Storage;
  /** What this server can offer when a video tool fails (core recovery.ts); input and mode come from the call. */
  recovery?: Omit<RecoveryContext, 'input' | 'mode'>;
}

/** The recovery context for one failed call. */
function recoveryFor(deps: ToolDeps, args: { url?: string }): RecoveryContext {
  const mode = (args as { mode?: unknown }).mode;
  return {
    ...(deps.recovery ?? { surface: 'mcp', keys: 'env' }),
    ...(args.url ? { input: args.url } : {}),
    ...(typeof mode === 'string' && (MODES as readonly string[]).includes(mode) ? { mode: mode as RecoveryContext['mode'] } : {}),
  };
}

const MODES = ['auto', 'captions', 'stt', 'video'] as const;

export const videoInput = {
  url: z.string().min(1).describe('Video URL (YouTube and more), a YouTube video id, or a local media file path'),
  mode: z
    .enum(MODES)
    .optional()
    .describe(
      'Transcript strategy: auto (captions, then speech-to-text), captions only, stt (always transcribe), video (multimodal model). Default: auto',
    ),
  language: z.string().optional().describe('Preferred transcript language (BCP-47, e.g. en, de). Default: the spoken language'),
};

/** Fetch (or read from the library) one video's context. Results are saved, so later calls and search_transcript reuse them. */
export function loadContext(
  deps: ToolDeps,
  args: { url: string; mode?: TranscriptMode; language?: string },
  ctx: Ctx,
  extra: { comments?: boolean | number; refresh?: boolean } = {},
): Promise<VideoContext> {
  return getVideoContext(
    deps.registry,
    args.url,
    { mode: args.mode ?? 'auto', language: args.language, storage: deps.storage, ...extra },
    ctx,
  );
}

function formatIds(): [string, ...string[]] {
  return Object.keys(formatters) as [string, ...string[]];
}

const CURSOR_RE = /^seg:(\d+)$/;

function parseCursor(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0;
  const m = CURSOR_RE.exec(cursor.trim());
  const n = m ? Number(m[1]) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || (total > 0 && n >= total)) {
    throw new Vid2ContextError('bad-request', `Invalid cursor "${cursor}".`, {
      hint: 'Pass the cursor exactly as the previous get_transcript result gave it (like "seg:412"), or omit it to start from the beginning.',
    });
  }
  return n;
}

function withSegments(context: VideoContext, start: number, end: number): VideoContext {
  return { ...context, transcript: { ...context.transcript, segments: context.transcript.segments.slice(start, end) } };
}

/**
 * Render a transcript, or one page of it when `maxTokens` is set and the
 * whole thing is larger. Pages are cut on segment boundaries and rendered by
 * the same formatter, so every page of every format is complete on its own
 * (a JSON page is valid JSON).
 */
export function renderTranscript(
  context: VideoContext,
  opts: { format: string; timestamps: boolean; maxTokens?: number; cursor?: string },
): string {
  const segs = context.transcript.segments;
  const header = opts.format === 'text' ? contextHeader(context) : '';
  const fmt = { timestamps: opts.timestamps };
  const start = parseCursor(opts.cursor, segs.length);
  if (start === 0) {
    const whole = header + render(context, opts.format, fmt);
    if (opts.maxTokens === undefined || estimateTokens(whole) <= opts.maxTokens) return whole;
  }
  if (opts.maxTokens === undefined) {
    return header + render(withSegments(context, start, segs.length), opts.format, fmt);
  }

  // Leave room for the header and the continuation note.
  const budget = Math.max(50, opts.maxTokens - estimateTokens(header) - 80);
  let end = start;
  let used = 0;
  while (end < segs.length) {
    const cost = estimateTokens(segs[end]?.text ?? '') + (opts.timestamps ? 5 : 1);
    if (end > start && used + cost > budget) break;
    used += cost;
    end++;
  }
  let body = render(withSegments(context, start, end), opts.format, fmt);
  while (end - start > 1 && estimateTokens(body) > budget) {
    end = start + Math.max(1, Math.floor((end - start) * 0.85));
    body = render(withSegments(context, start, end), opts.format, fmt);
  }

  const from = formatTimestamp(segs[start]?.startSec ?? 0);
  const to = formatTimestamp(segs[end - 1]?.endSec ?? 0);
  const part = `segments ${start + 1} to ${end} of ${segs.length} (${from} to ${to}), about ${estimateTokens(body)} tokens`;
  const note =
    end < segs.length
      ? `\n[Partial transcript: ${part}. To read on, call get_transcript again with the same arguments and cursor "seg:${end}". next_cursor: seg:${end}]\n`
      : `\n[End of transcript: ${part}.]\n`;
  return header + body + note;
}

function sectionLabel(info: SectionInfo, tokens: number): string {
  const name = info.chapterTitle ? ` "${info.chapterTitle}"` : '';
  return `Section${name}: ${formatTimestamp(info.fromSec)} to ${formatTimestamp(info.toSec)}, about ${tokens} tokens\n`;
}

const timeArg = z.union([z.number().nonnegative(), z.string().min(1)]).optional();

const outlineOutput = {
  title: z.string(),
  url: z.string().optional(),
  durationSec: z.number(),
  transcript: z.object({ origin: z.string(), language: z.string(), producer: z.string() }),
  sections: z.enum(['chapters', 'time']).describe("chapters: the video's own chapters; time: sections of about five minutes"),
  totalTokens: z.number(),
  chapters: z.array(
    z.object({
      index: z.number(),
      title: z.string(),
      startSec: z.number(),
      endSec: z.number().optional(),
      start: z.string(),
      tokens: z.number(),
      url: z.string().optional(),
    }),
  ),
  metadata: z.record(z.string(), z.json()),
  next: z.string(),
};

const commentFields = {
  id: z.string(),
  author: z.string(),
  text: z.string(),
  likes: z.number().optional(),
  publishedAt: z.string().optional(),
  isCreator: z.boolean().optional(),
  isPinned: z.boolean().optional(),
};
const commentShape = z.object({ ...commentFields, replies: z.array(z.object(commentFields)).optional() });

/** Only the declared Comment fields, so structured output matches its schema exactly. */
function commentOut(c: Comment, withReplies = true): z.infer<typeof commentShape> {
  return {
    id: c.id,
    author: c.author,
    text: c.text,
    ...(c.likes !== undefined ? { likes: c.likes } : {}),
    ...(c.publishedAt ? { publishedAt: c.publishedAt } : {}),
    ...(c.isCreator !== undefined ? { isCreator: c.isCreator } : {}),
    ...(c.isPinned !== undefined ? { isPinned: c.isPinned } : {}),
    ...(withReplies && c.replies ? { replies: c.replies.map((r) => commentOut(r, false)) } : {}),
  };
}

export function registerVideoTools(server: McpServer, deps: ToolDeps): void {
  const { registry } = deps;

  server.registerTool(
    'get_transcript',
    {
      title: 'Get video transcript',
      description:
        'The full transcript of one video or local media file, with a header (title, channel, URL, duration, how the transcript was made, chapters). ' +
        'With timestamps (the default) every line starts with [m:ss] so you can cite moments. ' +
        'Uses creator captions, then platform auto-captions, then speech-to-text. ' +
        'Cost: speech is about 12k tokens per hour of video. For videos longer than about 20 minutes, call get_outline first and read only the sections you need with get_section, ' +
        'or set maxTokens to receive the transcript in pages (each page ends with a cursor for the next one). ' +
        `Formats: ${Object.values(formatters)
          .map((f) => `${f.id} (${f.description})`)
          .join('; ')}`,
      inputSchema: {
        ...videoInput,
        format: z.enum(formatIds()).optional().describe('Output format (see list_formats). Default: text'),
        timestamps: z.boolean().optional().describe('Prefix lines with [m:ss] timestamps. Default: true'),
        maxTokens: z
          .number()
          .int()
          .min(200)
          .optional()
          .describe(
            'Largest result to return, in estimated tokens. Longer transcripts come back in pages with a continuation cursor',
          ),
        cursor: z
          .string()
          .optional()
          .describe('Continuation cursor from a previous partial result (like "seg:412"). Use the same other arguments'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args, extra) => {
      try {
        const context = await loadContext(deps, args, callCtx(deps.ctx, extra.signal));
        return text(
          renderTranscript(context, {
            format: args.format ?? 'text',
            timestamps: args.timestamps ?? true,
            maxTokens: args.maxTokens,
            cursor: args.cursor,
          }),
        );
      } catch (err) {
        return toolError(err, recoveryFor(deps, args));
      }
    },
  );

  server.registerTool(
    'get_metadata',
    {
      title: 'Get video metadata',
      description:
        'Title, channel, description, duration, publish date, chapters, tags and language for a video URL or local file, without fetching the transcript. ' +
        'Cheap: a few hundred tokens, mostly the description.',
      inputSchema: { url: videoInput.url },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args, extra) => {
      try {
        const { source, ref } = registry.resolve(args.url);
        const metadata = await source.getMetadata(ref, callCtx(deps.ctx, extra.signal));
        return text(JSON.stringify(metadata, null, 2));
      } catch (err) {
        return toolError(err, recoveryFor(deps, args));
      }
    },
  );

  server.registerTool(
    'list_formats',
    {
      title: 'List output formats',
      description:
        'The output formats get_transcript and get_section accept (text, json, markdown, srt, vtt, pack, ...), with what each is for. ' +
        'combinesVideos marks formats that can merge several videos into one document (export_context_pack). Cheap: under 500 tokens.',
      inputSchema: {},
      outputSchema: {
        formats: z.array(
          z.object({
            id: z.string(),
            description: z.string(),
            mimeType: z.string(),
            extension: z.string(),
            combinesVideos: z.boolean(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async () =>
      structured({
        formats: Object.values(formatters).map((f) => ({
          id: f.id,
          description: f.description,
          mimeType: f.mimeType,
          extension: f.extension,
          combinesVideos: typeof f.renderMany === 'function',
        })),
      }),
  );

  server.registerTool(
    'get_outline',
    {
      title: 'Get video outline',
      description:
        "Start here for any video longer than about 20 minutes. Returns the metadata and the video's chapters (or sections of about five minutes when it has none), " +
        'each with its start time, a timestamp link and its estimated token count, plus the total. ' +
        'Then read only what you need with get_section (by chapter index or title, or by time). ' +
        'Fetches the transcript once (saved for later calls); the outline itself costs about 300 to 1,500 tokens.',
      inputSchema: videoInput,
      outputSchema: outlineOutput,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args, extra) => {
      try {
        const context = await loadContext(deps, args, callCtx(deps.ctx, extra.signal));
        const api = outlineForApi(context);
        const outline = transcriptOutline(context);
        const ref = context.metadata.ref;
        return structured({
          title: context.metadata.title,
          ...(ref.url ? { url: ref.url } : {}),
          durationSec: outline.durationSec,
          transcript: {
            origin: context.transcript.origin,
            language: context.transcript.language,
            producer: context.transcript.producer,
          },
          sections: outline.sections[0]?.source ?? (context.metadata.chapters.length > 0 ? 'chapters' : 'time'),
          totalTokens: api.totalTokens,
          chapters: api.chapters.map((c, index) => {
            const url = timestampUrl(ref, c.startSec);
            return { index, ...c, start: formatTimestamp(c.startSec), ...(url ? { url } : {}) };
          }),
          metadata: JSON.parse(JSON.stringify(api.metadata)) as Record<string, z.infer<ReturnType<typeof z.json>>>,
          next:
            api.totalTokens > 15000
              ? 'This video is long: read the chapters you need with get_section { url, chapter }, or search_transcript for a topic.'
              : 'Small enough to read whole with get_transcript, or read chapters with get_section { url, chapter }.',
        });
      } catch (err) {
        return toolError(err, recoveryFor(deps, args));
      }
    },
  );

  server.registerTool(
    'get_section',
    {
      title: 'Get a transcript section',
      description:
        "One chapter or time range of a video's transcript, with the same header as get_transcript. " +
        'Pass chapter (an index or title from get_outline) or from/to (seconds, m:ss or h:mm:ss); from alone reads to the end, to alone reads from the start. ' +
        "Cost: the section's token count from get_outline (about 1k tokens per 5 minutes of speech).",
      inputSchema: {
        ...videoInput,
        from: timeArg.describe('Start time: seconds (754), m:ss (12:34) or h:mm:ss (1:02:03). Default: the start'),
        to: timeArg.describe('End time (exclusive), same forms as from. Default: the end'),
        chapter: z
          .union([z.number().int().nonnegative(), z.string().min(1)])
          .optional()
          .describe(
            'A chapter index from get_outline, or a chapter title (exact, prefix, then substring match, case-insensitive)',
          ),
        format: z.enum(formatIds()).optional().describe('Output format. Default: text'),
        timestamps: z.boolean().optional().describe('Prefix lines with [m:ss] timestamps. Default: true'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args, extra) => {
      try {
        if (args.from === undefined && args.to === undefined && args.chapter === undefined) {
          throw new Vid2ContextError('bad-request', 'get_section needs chapter, from or to.', {
            hint: 'Call get_outline to see the chapters and their times, or use get_transcript for the whole video.',
          });
        }
        const context = await loadContext(deps, args, callCtx(deps.ctx, extra.signal));
        const section = getSection(context, {
          fromSec: args.from === undefined ? undefined : parseTimeArg(args.from),
          toSec: args.to === undefined ? undefined : parseTimeArg(args.to),
          chapter: args.chapter,
        });
        const format = args.format ?? 'text';
        const body = render(section, format, { timestamps: args.timestamps ?? true });
        if (format !== 'text') return text(body);
        const info = section.metadata.extra?.section as SectionInfo;
        return text(contextHeader(section) + sectionLabel(info, estimateTokens(body)) + '\n' + body);
      } catch (err) {
        return toolError(err, recoveryFor(deps, args));
      }
    },
  );

  server.registerTool(
    'get_comments',
    {
      title: 'Get video comments',
      description:
        'Top comments of a video, with creator replies and pinned comments flagged. Useful for corrections, follow-up questions and audience consensus that the video itself lacks. ' +
        'Cost: about 50 tokens per comment; limit defaults to 50. Only sources whose provider can read comments support this.',
      inputSchema: {
        url: videoInput.url,
        limit: z.number().int().min(1).max(500).optional().describe('Most comments to return. Default: 50'),
      },
      outputSchema: {
        title: z.string(),
        url: z.string().optional(),
        count: z.number(),
        comments: z.array(commentShape),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args, extra) => {
      try {
        const ctx = callCtx(deps.ctx, extra.signal);
        const { source, ref } = registry.resolve(args.url);
        if (!source.getComments) {
          throw new Vid2ContextError('unsupported-input', `${source.name} cannot read comments yet.`, {
            hint: 'Comments are only available for sources whose provider supports them. Use get_transcript for what the video says.',
          });
        }
        const limit = args.limit ?? 50;
        // Comments do not need a transcript, so read them straight from the source (a saved context with enough comments is reused).
        const cached = await deps.storage.getContext(ref.id);
        const comments =
          cached?.comments && cached.comments.length >= limit
            ? cached.comments.slice(0, limit)
            : (await source.getComments(ref, ctx, { limit })).slice(0, limit);
        let title = cached?.metadata.title;
        if (!title) {
          try {
            title = (await source.getMetadata(ref, ctx)).title;
          } catch (err) {
            ctx.log.debug('get_comments: metadata unavailable, continuing without a title', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return structured({
          title: title ?? ref.url ?? args.url,
          ...(ref.url ? { url: ref.url } : {}),
          count: comments.length,
          comments: comments.map((c) => commentOut(c)),
        });
      } catch (err) {
        return toolError(err, recoveryFor(deps, args));
      }
    },
  );
}
