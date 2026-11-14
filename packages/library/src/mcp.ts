/**
 * Collection tools for the MCP server. Item 44 (or the integration pass)
 * calls registerLibraryTools(server, deps) from createServer:
 *
 *   list_collections   collections with video and source counts
 *   create_collection  a new collection; sources (playlists, channels, feeds) are followed
 *   add_to_collection  ingest videos or lists now, return the updated collection and what happened
 *   get_collection     the collection with video summaries, pending inputs and watch list
 *
 * Failures are tool results with isError and the standard JSON error body,
 * never protocol errors. Each call gets its own Ctx carrying its abort signal.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  attemptsOf,
  type Ctx,
  hasKv,
  type KvStore,
  MemoryKv,
  MemoryStorage,
  type Registry,
  type Storage,
  Vid2ContextError,
} from '@vid2context/core';
import { z } from 'zod';
import { createLibrary, type Library, type LibraryDeps } from './library.ts';

export interface LibraryToolDeps {
  registry: Registry;
  ctx: Ctx;
  /**
   * The library backend: a Storage, or a factory opening one per call.
   * Omitted: the registry's enabled storage provider, else one process-wide MemoryStorage.
   */
  storage?: Storage | ((ctx: Ctx) => Promise<Storage | null>);
  /** Watch lists and seen sets. Default: the storage when it implements KvStore, else one process-wide MemoryKv. */
  kv?: KvStore;
  library?: Pick<LibraryDeps, 'webhook' | 'leaseTtlSec' | 'now'>;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const json = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });

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

export function registerLibraryTools(server: McpServer, deps: LibraryToolDeps): void {
  const fallbackStorage = new MemoryStorage();
  const fallbackKv = new MemoryKv();

  const open = async (signal?: AbortSignal): Promise<Library> => {
    const ctx: Ctx = { ...deps.ctx, signal: signal ?? deps.ctx.signal };
    const s = deps.storage;
    const storage =
      (typeof s === 'function' ? await s(ctx) : s === undefined ? await deps.registry.openStorage(ctx) : s) ?? fallbackStorage;
    const kv = deps.kv ?? (hasKv(storage) ? storage : fallbackKv);
    return createLibrary({ registry: deps.registry, storage, ctx, kv, ...deps.library });
  };

  server.registerTool(
    'list_collections',
    {
      title: 'List collections',
      description:
        'List research collections with how many videos and sources each has. A collection groups videos on one topic and can follow playlists, channels and podcast feeds.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => {
      try {
        const lib = await open(extra.signal);
        const collections = await lib.listCollections();
        return json({
          collections: collections.map((c) => ({
            id: c.id,
            name: c.name,
            ...(c.description ? { description: c.description } : {}),
            videos: c.videoIds.length,
            sources: c.sources,
            updatedAt: c.updatedAt,
          })),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'create_collection',
    {
      title: 'Create collection',
      description:
        'Create a research collection. sources are playlists, channels or podcast feeds the collection follows: ' +
        'add_to_collection or a refresh ingests their videos, and watch lists pick up new uploads. Returns the collection with its id.',
      inputSchema: {
        name: z.string().min(1).describe('Collection name, for example "G-Wagon"'),
        description: z.string().optional().describe('What the collection is about'),
        sources: z.array(z.string().min(1)).optional().describe('Playlist, channel or feed URLs to follow'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      try {
        const lib = await open(extra.signal);
        return json(await lib.createCollection(args));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'add_to_collection',
    {
      title: 'Add to collection',
      description:
        'Ingest videos into a collection now: each URL is a video or a list (playlist, channel, feed), and lists are expanded. ' +
        'Transcripts come from captions first, speech-to-text only when needed. Videos already in the collection are skipped and per-video failures are reported without stopping. ' +
        'Returns the updated collection and a summary (added, skipped, failed with hints).',
      inputSchema: {
        collection: z.string().min(1).describe('Collection id'),
        urls: z.array(z.string().min(1)).min(1).describe('Video, playlist, channel or feed URLs'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const lib = await open(extra.signal);
        const summary = await lib.addVideos(args.collection, args.urls);
        const collection = await lib.getCollection(args.collection);
        return json({
          collection,
          summary: {
            added: summary.added.map((v) => ({ id: v.id, title: v.title, url: v.ref.url, origin: v.origin })),
            skipped: summary.skipped,
            failed: summary.failed,
            remaining: summary.remaining,
            checkedAt: summary.checkedAt,
          },
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'get_collection',
    {
      title: 'Get collection',
      description:
        'A collection with a summary of each video (id, title, channel, duration, URL, transcript origin), the sources it follows, inputs waiting for the next refresh and its watch list. ' +
        'Read transcripts with get_transcript, get_outline or search_transcript.',
      inputSchema: { collection: z.string().min(1).describe('Collection id') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      try {
        const lib = await open(extra.signal);
        return json(await lib.getCollectionDetail(args.collection));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
