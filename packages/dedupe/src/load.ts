/**
 * Loading the contexts to compare (from inputs or a saved collection) and
 * annotating results with titles, links and [m:ss] offsets. Shared by the
 * HTTP route and the MCP tool. The comparison itself (dedupe.ts) never touches
 * the network; this file does, through the pipeline and the caller's Ctx.
 */
import {
  type Ctx,
  expandInput,
  formatTimestamp,
  getVideoContext,
  type Registry,
  type Storage,
  timestampUrl,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { findDuplicates } from './dedupe.ts';
import type { DedupeOptions, DuplicatesResult } from './types.ts';

/** Most videos one request may compare. 200 one-hour transcripts take seconds; the cap keeps a request bounded. */
export const MAX_VIDEOS = 500;

export interface DuplicatesRequest {
  /** Video URLs, ids, playlists or channels (lists are expanded). */
  inputs?: string[];
  /** A saved collection id. */
  collectionId?: string;
  options?: DedupeOptions;
}

export interface LoadFailure {
  input: string;
  code: string;
  message: string;
}

export interface VideoInfo {
  title: string;
  channel?: string;
  durationSec?: number;
  url?: string;
}

export type DuplicatesReport = DuplicatesResult & {
  /** Title, channel, duration and link for every compared video. */
  videos: Record<string, VideoInfo>;
  /** Inputs that could not be loaded; the rest were still compared. */
  failed: LoadFailure[];
};

function failure(input: string, err: unknown): LoadFailure {
  return {
    input,
    code: err instanceof Vid2ContextError ? err.code : 'error',
    message: err instanceof Error ? err.message : String(err),
  };
}

/** Load every context a request names. Per-video failures are reported, not thrown; a bad request throws. */
export async function loadContexts(
  req: DuplicatesRequest,
  deps: { registry: Registry; storage?: Storage | null },
  ctx: Ctx,
): Promise<{ contexts: VideoContext[]; failed: LoadFailure[] }> {
  const inputs = req.inputs ?? [];
  if (!Array.isArray(inputs) || inputs.some((i) => typeof i !== 'string' || i.trim() === '')) {
    throw new Vid2ContextError('bad-request', '`inputs` must be an array of non-empty strings.', {
      hint: 'Pass video URLs, for example { "inputs": ["https://www.youtube.com/watch?v=jNQXAC9IVRw"] }.',
    });
  }
  if (inputs.length === 0 && !req.collectionId) {
    throw new Vid2ContextError('bad-request', 'Nothing to compare: give `inputs` (urls) or a collection.', {
      hint: 'Pass two or more video URLs, a playlist, or the id of a saved collection.',
    });
  }

  const contexts: VideoContext[] = [];
  const failed: LoadFailure[] = [];
  const tooMany = () =>
    new Vid2ContextError('too-large', `More than ${MAX_VIDEOS} videos in one request.`, {
      hint: `Split the comparison into batches of at most ${MAX_VIDEOS} videos.`,
    });

  if (req.collectionId) {
    if (!deps.storage) {
      throw new Vid2ContextError('bad-request', 'Collections need a library, and none is configured here.', {
        hint: 'Pass video URLs instead, or run with a storage backend (SQLite, D1, Postgres).',
      });
    }
    const collection = await deps.storage.getCollection(req.collectionId);
    if (!collection) {
      throw new Vid2ContextError('not-found', `Collection not found: ${req.collectionId}`, {
        hint: 'List collections to see valid ids.',
      });
    }
    if (collection.videoIds.length > MAX_VIDEOS) throw tooMany();
    for (const id of collection.videoIds) {
      const c = await deps.storage.getContext(id);
      if (c) contexts.push(c);
      else failed.push({ input: id, code: 'not-found', message: `${id} is in the collection but its context is not saved.` });
    }
  }

  const refs: { input: string; target: string }[] = [];
  for (const input of inputs) {
    try {
      for (const ref of await expandInput(deps.registry, input, ctx, { limit: MAX_VIDEOS })) {
        refs.push({ input, target: ref.url ?? ref.input });
      }
    } catch (err) {
      failed.push(failure(input, err));
    }
  }
  if (contexts.length + refs.length > MAX_VIDEOS) throw tooMany();

  // A few at a time, results kept in input order.
  const loaded: (VideoContext | undefined)[] = new Array(refs.length);
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const k = next++;
      const ref = refs[k] as { input: string; target: string };
      try {
        loaded[k] = await getVideoContext(deps.registry, ref.target, { storage: deps.storage ?? null }, ctx);
      } catch (err) {
        failed.push(failure(ref.target, err));
      }
      if (ctx.signal?.aborted) return;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, refs.length) }, worker));
  for (const c of loaded) if (c) contexts.push(c);
  return { contexts, failed };
}

/** Add titles, links and readable offsets so an agent can cite what it reports. */
export function annotate(result: DuplicatesResult, contexts: VideoContext[], failed: LoadFailure[] = []): DuplicatesReport {
  const videos: Record<string, VideoInfo> = {};
  const byId = new Map<string, VideoContext>();
  for (const c of contexts) {
    const m = c.metadata;
    byId.set(m.ref.id, c);
    videos[m.ref.id] = { title: m.title, channel: m.channel?.name, durationSec: m.durationSec, url: m.ref.url };
  }
  const groups = result.groups.map((g) => {
    const original = g.original ? byId.get(g.original) : undefined;
    return {
      ...g,
      members: g.members.map((member) => {
        if (member.offsetSec === undefined || !original) return member;
        const at = Math.max(0, member.offsetSec);
        return { ...member, startsAt: `[${formatTimestamp(at)}]`, startsAtUrl: timestampUrl(original.metadata.ref, at) };
      }),
    };
  });
  return { ...result, groups, videos, failed };
}

/** Load, compare and annotate: what the HTTP route and the MCP tool return. */
export async function duplicatesReport(
  req: DuplicatesRequest,
  deps: { registry: Registry; storage?: Storage | null },
  ctx: Ctx,
): Promise<DuplicatesReport> {
  const { contexts, failed } = await loadContexts(req, deps, ctx);
  const result = findDuplicates(contexts, req.options);
  return annotate(result, contexts, failed);
}
