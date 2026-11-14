/**
 * Gathers the contexts an export covers, shared by the MCP tools and the HTTP
 * routes: inputs (videos, playlists, channels, feeds, expanded through the
 * registry) and a saved collection (read from storage).
 */
import {
  type Collection,
  type Ctx,
  expandInput,
  getVideoContext,
  type Registry,
  type Storage,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';

export interface ExportSelection {
  inputs?: string[];
  collectionId?: string;
}

export interface LoadedContexts {
  contexts: VideoContext[];
  collection?: Collection;
  /** Collection video ids with no saved context. */
  missing: string[];
}

export async function loadContexts(
  deps: { registry: Registry; storage?: Storage | null },
  selection: ExportSelection,
  ctx: Ctx,
): Promise<LoadedContexts> {
  const inputs = (selection.inputs ?? []).map((s) => s.trim()).filter(Boolean);
  if (inputs.length === 0 && !selection.collectionId) {
    throw new Vid2ContextError('bad-request', 'Nothing to export.', {
      hint: 'Pass video or playlist URLs, a collection id, or both.',
    });
  }
  const contexts: VideoContext[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  let collection: Collection | undefined;

  if (selection.collectionId) {
    if (!deps.storage) {
      throw new Vid2ContextError('no-provider', 'Collections need a library storage backend, and none is configured here.', {
        hint: 'Pass the video URLs instead, or configure a storage provider.',
      });
    }
    const found = await deps.storage.getCollection(selection.collectionId);
    if (!found) {
      throw new Vid2ContextError('not-found', `Collection not found: ${selection.collectionId}`, {
        hint: 'List collections to see valid ids.',
      });
    }
    collection = found;
    for (const id of found.videoIds) {
      const context = await deps.storage.getContext(id);
      if (!context) {
        missing.push(id);
        ctx.log.warn('collection video has no saved context, leaving it out of the export', { id });
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      contexts.push(context);
    }
  }

  for (const input of inputs) {
    for (const ref of await expandInput(deps.registry, input, ctx)) {
      if (seen.has(ref.id)) continue;
      const context = await getVideoContext(deps.registry, ref.url ?? ref.input, { storage: deps.storage ?? null }, ctx);
      if (seen.has(context.metadata.ref.id)) continue;
      seen.add(context.metadata.ref.id);
      contexts.push(context);
    }
  }
  return { contexts, collection, missing };
}
