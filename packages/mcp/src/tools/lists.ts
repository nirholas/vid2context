/**
 * Tools over many videos and the saved library: list_items and
 * export_context_pack. search_transcript comes from @vid2context/search and
 * the collection tools from @vid2context/library (see wire.ts);
 * collectionView here backs the vid2context://collection/{id} resource.
 *
 * Every video read through any tool is saved to the server's storage, so the
 * library grows as the agent works and search covers everything read so far.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type Collection,
  type Ctx,
  estimateTokens,
  expandInput,
  getVideoContext,
  renderMany,
  type Storage,
  segmentsToText,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { z } from 'zod';
import { callCtx, type Extra, findCollection, progress, structured, toolError } from '../shared.ts';
import type { ToolDeps } from './video.ts';

/** Default and largest number of videos taken from one playlist, channel or feed. */
export const LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export interface IngestFailure {
  input: string;
  error: string;
  message: string;
  hint?: string;
}

export interface IngestResult {
  contexts: VideoContext[];
  failed: IngestFailure[];
}

function failure(input: string, err: unknown): IngestFailure {
  const e = err instanceof Vid2ContextError ? err : undefined;
  return {
    input,
    error: e?.code ?? 'error',
    message: err instanceof Error ? err.message : String(err),
    ...(e?.hint ? { hint: e.hint } : {}),
  };
}

/**
 * Expand every input (playlists, channels and feeds become their videos) and
 * read each video once, saving it. One bad video never fails the batch: it is
 * reported in `failed`. Sends progress notifications when the client asked.
 */
export async function ingest(
  deps: ToolDeps,
  inputs: string[],
  ctx: Ctx,
  extra: Extra,
  opts: { limit?: number; onVideo?: (c: VideoContext) => Promise<void> } = {},
): Promise<IngestResult> {
  const urls: string[] = [];
  const failed: IngestFailure[] = [];
  for (const input of inputs) {
    try {
      const found = await expandInput(deps.registry, input, ctx, { limit: opts.limit ?? LIST_LIMIT });
      for (const r of found) urls.push(r.url ?? r.input);
    } catch (err) {
      failed.push(failure(input, err));
    }
  }
  const contexts: VideoContext[] = [];
  const seen = new Set<string>();
  for (const [i, url] of urls.entries()) {
    if (ctx.signal?.aborted) break;
    await progress(extra, i, urls.length, `Reading video ${i + 1} of ${urls.length}`);
    try {
      const c = await getVideoContext(deps.registry, url, { storage: deps.storage }, ctx);
      if (seen.has(c.metadata.ref.id)) continue;
      seen.add(c.metadata.ref.id);
      contexts.push(c);
      await opts.onVideo?.(c);
    } catch (err) {
      failed.push(failure(url, err));
    }
  }
  if (urls.length > 0) await progress(extra, urls.length, urls.length, `Read ${contexts.length} of ${urls.length} videos`);
  return { contexts, failed };
}

const urlsInput = z
  .array(z.string().min(1))
  .min(1)
  .max(100)
  .describe('Video, playlist, channel or feed URLs (lists are expanded into their videos)');
const limitInput = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIST_LIMIT)
  .optional()
  .describe(`Most videos taken from each playlist, channel or feed. Default: ${LIST_LIMIT}`);

function collectionInfo(c: Collection) {
  return {
    id: c.id,
    name: c.name,
    ...(c.description ? { description: c.description } : {}),
    sources: c.sources,
    videoCount: c.videoIds.length,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function videoSummary(c: VideoContext) {
  const m = c.metadata;
  return {
    id: m.ref.id,
    title: m.title,
    ...(m.ref.url ? { url: m.ref.url } : {}),
    ...(m.channel ? { channel: m.channel.name } : {}),
    ...(m.durationSec !== undefined ? { durationSec: m.durationSec } : {}),
    ...(m.publishedAt ? { publishedAt: m.publishedAt } : {}),
    origin: c.transcript.origin,
    language: c.transcript.language,
    chapters: m.chapters.length,
    tokens: estimateTokens(segmentsToText(c.transcript.segments)),
  };
}

/** A collection with a summary of each saved video and the token total (get_collection and the collection resource). */
export async function collectionView(storage: Storage, col: Collection) {
  const videos: ReturnType<typeof videoSummary>[] = [];
  const missing: string[] = [];
  for (const id of col.videoIds) {
    const c = await storage.getContext(id);
    if (c) videos.push(videoSummary(c));
    else missing.push(id);
  }
  return { collection: collectionInfo(col), videos, totalTokens: videos.reduce((sum, v) => sum + v.tokens, 0), missing };
}

export function registerListTools(server: McpServer, deps: ToolDeps): void {
  const { registry, storage } = deps;

  server.registerTool(
    'list_items',
    {
      title: 'List the videos in a playlist, channel or feed',
      description:
        'Expand a playlist, channel, podcast feed or page into its videos (a single video URL returns itself). ' +
        'Use it to see what a list contains before reading, or pass the list straight to add_to_collection. ' +
        'Cost: about 40 tokens per item; limit defaults to 50.',
      inputSchema: {
        url: z.string().min(1).describe('Playlist, channel, feed or page URL'),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Most items to return. Default: ${LIST_LIMIT}`),
      },
      outputSchema: {
        input: z.string(),
        count: z.number(),
        items: z.array(
          z.object({ id: z.string(), platform: z.string(), kind: z.string(), nativeId: z.string(), url: z.string().optional() }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args, extra) => {
      try {
        const refs = await expandInput(registry, args.url, callCtx(deps.ctx, extra.signal), { limit: args.limit ?? LIST_LIMIT });
        return structured({
          input: args.url,
          count: refs.length,
          items: refs.map((r) => ({
            id: r.id,
            platform: r.platform,
            kind: r.kind,
            nativeId: r.nativeId,
            ...(r.url ? { url: r.url } : {}),
          })),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'export_context_pack',
    {
      title: 'Export a context pack',
      description:
        'One Markdown document for many videos (the pack format): a header per video with title, channel, URL and chapters, then each transcript in timestamped paragraphs. ' +
        'Set maxTokens to fit a budget: the pack trims transcripts to fit and says what it left out. ' +
        'Cost: about 12k tokens per hour of video unless maxTokens caps it. Prefer get_outline, get_section and search_transcript when you only need parts.',
      inputSchema: {
        urls: urlsInput.optional(),
        collection: z.string().optional().describe('Export this saved collection (id or name)'),
        maxTokens: z.number().int().min(500).optional().describe('Token budget for the whole pack'),
        limit: limitInput,
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async (args, extra) => {
      try {
        if (!args.urls && !args.collection) {
          throw new Vid2ContextError('bad-request', 'export_context_pack needs urls or collection.', {
            hint: 'Pass urls (videos or playlists) or a collection id from list_collections.',
          });
        }
        const ctx = callCtx(deps.ctx, extra.signal);
        const contexts: VideoContext[] = [];
        const missing: string[] = [];
        if (args.collection) {
          const col = await findCollection(storage, args.collection);
          for (const id of col.videoIds) {
            const c = await storage.getContext(id);
            if (c) contexts.push(c);
            else missing.push(id);
          }
        }
        let failed: IngestFailure[] = [];
        if (args.urls) {
          const res = await ingest(deps, args.urls, ctx, extra, { limit: args.limit });
          failed = res.failed;
          for (const c of res.contexts) {
            if (!contexts.some((x) => x.metadata.ref.id === c.metadata.ref.id)) contexts.push(c);
          }
        }
        if (contexts.length === 0) {
          const why = failed.map((f) => `${f.input}: ${f.message}`).join('; ');
          throw new Vid2ContextError('no-transcript', `None of the requested videos could be read${why ? ` (${why})` : ''}.`, {
            hint: failed[0]?.hint ?? 'Check the inputs, or add videos to the collection with add_to_collection.',
          });
        }
        const pack = renderMany(contexts, 'pack', { maxTokens: args.maxTokens });
        const notes = [
          ...failed.map((f) => `- Could not read ${f.input}: ${f.message}${f.hint ? ` (${f.hint})` : ''}`),
          ...missing.map((id) => `- ${id} is in the collection but no longer saved; add it again with add_to_collection.`),
        ];
        return {
          content: [{ type: 'text', text: notes.length > 0 ? `${pack}\n\nNot included:\n${notes.join('\n')}\n` : pack }],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
