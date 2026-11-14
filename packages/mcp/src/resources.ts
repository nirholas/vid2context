/**
 * MCP resources over the saved library:
 *
 *   vid2context://video/{id}             the saved VideoContext as JSON
 *   vid2context://video/{id}/transcript  the text transcript with [m:ss] timestamps
 *   vid2context://collection/{id}        the collection with video summaries
 *
 * `id` is the ref id (`youtube:jNQXAC9IVRw`) URL-encoded. Listing shows what
 * is saved; videos are saved whenever a tool reads them.
 */
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { render, type Storage, Vid2ContextError, type VideoContext, type VideoSummary } from '@vid2context/core';
import { contextHeader } from './shared.ts';
import { collectionView } from './tools/lists.ts';

/** Most saved videos listed (newest first). */
export const RESOURCE_LIST_LIMIT = 500;

export const videoUri = (id: string) => `vid2context://video/${encodeURIComponent(id)}`;
export const transcriptUri = (id: string) => `${videoUri(id)}/transcript`;
export const collectionUri = (id: string) => `vid2context://collection/${encodeURIComponent(id)}`;

async function savedVideos(storage: Storage): Promise<VideoSummary[]> {
  const out: VideoSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.listContexts({ limit: 100, cursor });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor && out.length < RESOURCE_LIST_LIMIT);
  return out.slice(0, RESOURCE_LIST_LIMIT);
}

function param(value: string | string[] | undefined): string {
  return decodeURIComponent(Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));
}

async function mustContext(storage: Storage, id: string): Promise<VideoContext> {
  const c = await storage.getContext(id);
  if (!c) {
    throw new Vid2ContextError('not-found', `No saved video with id ${id}.`, {
      hint: 'Read the video with get_transcript or get_outline first (that saves it), or list resources to see saved ids.',
    });
  }
  return c;
}

export function registerResources(server: McpServer, storage: Storage): void {
  server.registerResource(
    'video',
    new ResourceTemplate('vid2context://video/{id}', {
      list: async () => ({
        resources: (await savedVideos(storage)).map((v) => ({
          uri: videoUri(v.id),
          name: v.title,
          mimeType: 'application/json',
          description: `Saved context${v.channel ? ` from ${v.channel}` : ''} (${v.origin}, ${v.language})`,
        })),
      }),
    }),
    {
      title: 'Saved video context',
      description: 'A saved VideoContext as JSON: metadata, chapters, timed transcript segments and how it was produced.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const c = await mustContext(storage, param(vars.id));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(c, null, 2) }] };
    },
  );

  server.registerResource(
    'video-transcript',
    new ResourceTemplate('vid2context://video/{id}/transcript', {
      list: async () => ({
        resources: (await savedVideos(storage)).map((v) => ({
          uri: transcriptUri(v.id),
          name: `${v.title} (transcript)`,
          mimeType: 'text/plain',
        })),
      }),
    }),
    {
      title: 'Saved video transcript',
      description: 'The text transcript of a saved video, with the header and [m:ss] timestamps.',
      mimeType: 'text/plain',
    },
    async (uri, vars) => {
      const c = await mustContext(storage, param(vars.id));
      return {
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: contextHeader(c) + render(c, 'text', { timestamps: true }) }],
      };
    },
  );

  server.registerResource(
    'collection',
    new ResourceTemplate('vid2context://collection/{id}', {
      list: async () => ({
        resources: (await storage.listCollections()).map((c) => ({
          uri: collectionUri(c.id),
          name: c.name,
          mimeType: 'application/json',
          description: `${c.videoIds.length} videos${c.description ? `: ${c.description}` : ''}`,
        })),
      }),
    }),
    {
      title: 'Collection',
      description: 'A saved collection with a summary of each video (title, URL, duration, transcript origin, estimated tokens).',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const id = param(vars.id);
      const col = await storage.getCollection(id);
      if (!col) {
        throw new Vid2ContextError('not-found', `Collection not found: ${id}`, {
          hint: 'Call list_collections or list resources to see valid ids.',
        });
      }
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await collectionView(storage, col), null, 2) },
        ],
      };
    },
  );
}
