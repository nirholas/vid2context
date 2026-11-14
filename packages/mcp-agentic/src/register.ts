/**
 * registerAgenticFeatures: mount sampling, elicitation, completions and
 * subscriptions on any McpServer. Transport-neutral: the same call works for
 * stdio and Streamable HTTP. Call it before `server.connect(...)`, because MCP
 * capabilities (resources.subscribe, completions) are fixed at initialization
 * and the SDK refuses to register them once a transport is connected.
 */
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { type Storage, Vid2ContextError } from '@vid2context/core';
import { z } from 'zod';
import { completeCollections, completeListItem, completeVideos, MAX_COMPLETIONS } from './completions.ts';
import { digestInputSchema, runDigest } from './digest.ts';
import { chooseCaptionTrack } from './elicitation.ts';
import { findCollection, splitList } from './inputs.ts';
import { type AgenticDeps, callCtx, rememberDeps, storageOpener, toolError } from './shared.ts';
import { collectionLatestUri, enableSubscriptions } from './subscriptions.ts';

/** How many videos the latest resource lists. */
export const LATEST_LIMIT = 20;

async function latestJson(storage: Storage, idOrName: string): Promise<string> {
  const col = await findCollection(storage, idOrName);
  if (!col) {
    throw new Vid2ContextError('not-found', `Collection not found: ${idOrName}`, {
      hint: 'Use a collection id from list_collections.',
    });
  }
  // Collections append new videos at the end, so the newest additions come first here.
  const ids = [...col.videoIds].reverse().slice(0, LATEST_LIMIT);
  const latest = await Promise.all(
    ids.map(async (id) => {
      const c = await storage.getContext(id);
      if (!c) return { id, saved: false };
      const m = c.metadata;
      return {
        id,
        title: m.title,
        url: m.ref.url,
        channel: m.channel?.name,
        durationSec: m.durationSec,
        publishedAt: m.publishedAt,
        transcript: c.transcript.origin,
        language: c.transcript.language,
      };
    }),
  );
  return JSON.stringify(
    {
      collection: {
        id: col.id,
        name: col.name,
        description: col.description,
        sources: col.sources,
        videoCount: col.videoIds.length,
        updatedAt: col.updatedAt,
      },
      latest,
    },
    null,
    2,
  );
}

function digestPromptText(args: { collection?: string; urls?: string; question?: string }): string {
  const urls = splitList(args.urls);
  const call: Record<string, unknown> = {};
  if (args.collection) call.collection = args.collection;
  if (urls.length > 0) call.urls = urls;
  if (args.question) call.question = args.question;
  if (!args.collection && urls.length === 0) {
    return 'Ask me which videos, playlists or collection to digest (and any question the digest should answer), then call the digest_videos tool with them.';
  }
  return [
    `Call the digest_videos tool with ${JSON.stringify(call)}.`,
    '- If it returns a digest, present it as it is, keeping every [Title @ m:ss](link) citation, and mention any dropped claims or inputs it could not read.',
    '- If it returns a chunk plan ("mode": "chunk-plan"), follow its steps: read each chunk, write notes with its mapInstructions, then combine them with its reduceInstructions, citing every claim as [Title @ m:ss](link).',
  ].join('\n');
}

export function registerAgenticFeatures(server: McpServer, deps: AgenticDeps): void {
  rememberDeps(server, deps);
  const storage = storageOpener(deps);
  const { registry } = deps;

  enableSubscriptions(server);
  server.server.registerCapabilities({ completions: {} });

  server.registerResource(
    'collection-latest',
    new ResourceTemplate('vid2context://collection/{id}/latest', {
      list: async (extra) => {
        const s = await storage(callCtx(deps.ctx, extra.signal));
        const cols = s ? await s.listCollections() : [];
        return {
          resources: cols.map((c) => ({
            uri: collectionLatestUri(c.id),
            name: `${c.name}: latest`,
            description: `The ${LATEST_LIMIT} newest videos of "${c.name}" (${c.videoIds.length} in total). Subscribe to hear when it gains a video.`,
            mimeType: 'application/json',
          })),
        };
      },
      complete: {
        id: async (value) => {
          const s = await storage(deps.ctx);
          if (!s) return [];
          const p = value.trim().toLowerCase();
          return (await s.listCollections())
            .map((c) => c.id)
            .filter((id) => id.toLowerCase().startsWith(p))
            .slice(0, MAX_COMPLETIONS);
        },
      },
    }),
    {
      title: 'Newest videos in a collection',
      description: `The ${LATEST_LIMIT} newest videos of a collection as JSON. Subscribable: you get notifications/resources/updated when the collection gains videos.`,
      mimeType: 'application/json',
    },
    async (uri, variables, extra) => {
      const raw = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      const id = decodeURIComponent(String(raw ?? ''));
      const s = await storage(callCtx(deps.ctx, extra.signal));
      if (!s) {
        throw new McpError(ErrorCode.InvalidParams, 'Collections need a storage backend, and none is configured.', {
          hint: 'Configure a storage provider (see docs/providers.md).',
        });
      }
      try {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: await latestJson(s, id) }] };
      } catch (err) {
        if (err instanceof Vid2ContextError) {
          // -32002 is the MCP code for "resource not found".
          throw new McpError(err.code === 'not-found' ? -32002 : ErrorCode.InternalError, err.message, {
            uri: uri.href,
            hint: err.hint,
          });
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'digest_videos',
    {
      title: 'Digest videos with your own model',
      description:
        "Build one cited digest of several videos (a playlist, a collection, or a list of URLs) using MCP sampling: the server asks the client's model to take notes on each part of each transcript, then combine them. Every claim cites [Title @ m:ss](link), and every timestamp is checked against the real transcript. " +
        'No server key is needed. If this client cannot sample, the result is a chunk plan with the exact instructions, so you can do the same work yourself.',
      inputSchema: digestInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        return await runDigest(server, { registry, storage }, args, callCtx(deps.ctx, extra.signal), extra);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'choose_caption_track',
    {
      title: 'Choose a caption track',
      description:
        "List a video's caption tracks (languages, creator or auto-generated) and ask the user to pick one, then return that transcript with [m:ss] timestamps. " +
        'Without a picker in this client, or when the user declines, returns the track list so you can call get_transcript with a language.',
      inputSchema: { url: z.string().min(1).describe('Video URL') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        return await chooseCaptionTrack(server, registry, args.url, callCtx(deps.ctx, extra.signal), extra);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerPrompt(
    'digest',
    {
      title: 'Digest videos',
      description:
        'Build a cited digest of a collection or a list of videos with the digest_videos tool (your own model does the writing; claims cite [Title @ m:ss](link)).',
      argsSchema: {
        collection: completable(z.string().optional().describe('Collection id or name'), async (value) =>
          completeCollections(await storage(deps.ctx), value ?? ''),
        ),
        urls: completable(
          z.string().optional().describe('Video URLs, saved video ids or titles, separated by commas'),
          async (value) => completeListItem(value ?? '', async (p) => completeVideos(await storage(deps.ctx), p)),
        ),
        question: z.string().optional().describe('A question the digest should answer'),
      },
    },
    (args) => ({
      messages: [{ role: 'user', content: { type: 'text', text: digestPromptText(args) } }],
    }),
  );
}
