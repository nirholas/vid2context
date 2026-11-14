/**
 * Loading the VideoContexts a brief or extraction reads: from inputs (video
 * URLs or ids, playlists expanded when the source can list them), from a
 * saved collection, or both. Saved contexts are reused; new ones are saved.
 */
import {
  type Ctx,
  expandInput,
  getVideoContext,
  type Registry,
  type Storage,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';

/** More videos than this in one request is a collection-sized job; keep requests bounded. */
export const MAX_VIDEOS = 25;

/** Where saved contexts come from: a Storage, a per-call factory (the HTTP server's `storage(ctx)`), or null for none. Omitted: the registry's enabled storage provider, if any. */
export type StorageSource = Storage | null | ((ctx: Ctx) => Promise<Storage | null>);

export interface LoadDeps {
  registry: Registry;
  ctx: Ctx;
  storage?: StorageSource;
}

export interface LoadRequest {
  inputs?: string[];
  collectionId?: string;
}

async function openStorage(deps: LoadDeps): Promise<Storage | null> {
  const s = deps.storage;
  if (s === undefined) return deps.registry.openStorage(deps.ctx);
  if (typeof s === 'function') return s(deps.ctx);
  return s;
}

export async function loadContexts(req: LoadRequest, deps: LoadDeps): Promise<VideoContext[]> {
  const inputs = (req.inputs ?? []).map((s) => s.trim()).filter(Boolean);
  if (inputs.length === 0 && !req.collectionId) {
    throw new Vid2ContextError('bad-request', 'Nothing to read: no inputs and no collection.', {
      hint: 'Pass inputs (video URLs or ids) or a collectionId.',
    });
  }
  const storage = await openStorage(deps);
  const out: VideoContext[] = [];
  const seen = new Set<string>();
  const push = (c: VideoContext) => {
    if (seen.has(c.metadata.ref.id)) return;
    seen.add(c.metadata.ref.id);
    out.push(c);
  };

  if (req.collectionId) {
    if (!storage) {
      throw new Vid2ContextError('bad-request', 'Collections need a library, and no storage backend is configured.', {
        hint: 'Configure a storage provider (docs/providers.md), or pass the videos as inputs instead.',
      });
    }
    const col = await storage.getCollection(req.collectionId);
    if (!col) {
      throw new Vid2ContextError('not-found', `No collection "${req.collectionId}".`, {
        hint: 'List collections to find the id.',
      });
    }
    if (col.videoIds.length > MAX_VIDEOS) {
      throw new Vid2ContextError(
        'too-large',
        `Collection "${col.name}" has ${col.videoIds.length} videos; one request reads at most ${MAX_VIDEOS}.`,
        {
          hint: `Pass up to ${MAX_VIDEOS} of its videos as inputs.`,
        },
      );
    }
    for (const id of col.videoIds) {
      const c = await storage.getContext(id);
      if (c) push(c);
      else deps.ctx.log.warn('collection video is not saved, skipping', { collection: col.id, video: id });
    }
  }

  for (const input of inputs) {
    const refs = await expandInput(deps.registry, input, deps.ctx, { limit: MAX_VIDEOS });
    for (const ref of refs) {
      if (seen.has(ref.id)) continue;
      if (out.length >= MAX_VIDEOS) {
        throw new Vid2ContextError('too-large', `More than ${MAX_VIDEOS} videos in one request.`, {
          hint: `Pass at most ${MAX_VIDEOS} videos, or split the work into several briefs.`,
        });
      }
      push(await getVideoContext(deps.registry, ref.url ?? ref.input, { storage }, deps.ctx));
    }
  }
  if (out.length === 0) {
    throw new Vid2ContextError('bad-request', 'No videos to read: the collection has no saved videos.', {
      hint: 'Add videos to the collection first, or pass inputs.',
    });
  }
  return out;
}
