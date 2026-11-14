/**
 * Turn digest inputs (URLs, playlists, saved video ids or titles, a
 * collection id or name) into VideoContexts, using storage as the cache.
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
  type VideoSummary,
} from '@vid2context/core';

/** Most videos one digest reads; a channel or long playlist is cut here. */
export const MAX_VIDEOS = 50;
/** Most saved videos scanned when looking up a title or completing a prefix. */
export const MAX_SCAN = 1000;

export interface InputProblem {
  input: string;
  error: string;
  message: string;
}

export interface ResolvedSources {
  contexts: VideoContext[];
  problems: InputProblem[];
  /** Set when more than MAX_VIDEOS videos were found and the rest were left out. */
  truncated?: number;
}

/** Every saved video summary, newest first, up to MAX_SCAN. */
export async function allSummaries(storage: Storage): Promise<VideoSummary[]> {
  const out: VideoSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.listContexts({ limit: 200, cursor });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor && out.length < MAX_SCAN);
  return out.slice(0, MAX_SCAN);
}

/** A collection by id, else by name (case-insensitive). */
export async function findCollection(storage: Storage, idOrName: string): Promise<Collection | null> {
  const byId = await storage.getCollection(idOrName);
  if (byId) return byId;
  const want = idOrName.trim().toLowerCase();
  return (await storage.listCollections()).find((c) => c.name.trim().toLowerCase() === want) ?? null;
}

/** A saved video by ref id (youtube:abc) or exact title, for inputs that are not URLs. */
async function findSaved(storage: Storage, input: string): Promise<VideoContext | null> {
  const byId = await storage.getContext(input);
  if (byId) return byId;
  const want = input.trim().toLowerCase();
  const hit = (await allSummaries(storage)).find((s) => s.title.trim().toLowerCase() === want);
  return hit ? storage.getContext(hit.id) : null;
}

function problem(input: string, err: unknown): InputProblem {
  return {
    input,
    error: err instanceof Vid2ContextError ? err.code : 'error',
    message: err instanceof Error ? err.message : String(err),
  };
}

/** Split a prompt argument that lists several inputs (commas or new lines). */
export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function resolveSources(
  registry: Registry,
  storage: Storage | null,
  args: { urls?: string[]; collection?: string },
  ctx: Ctx,
): Promise<ResolvedSources> {
  const contexts: VideoContext[] = [];
  const problems: InputProblem[] = [];
  const seen = new Set<string>();
  let found = 0;
  const add = (c: VideoContext) => {
    const id = c.metadata.ref.id;
    if (seen.has(id)) return;
    seen.add(id);
    found++;
    if (contexts.length < MAX_VIDEOS) contexts.push(c);
  };

  if (args.collection) {
    if (!storage) {
      throw new Vid2ContextError('no-provider', 'Collections need a storage backend, and none is configured.', {
        hint: 'Pass `urls` instead, or configure a storage provider (see docs/providers.md).',
      });
    }
    const col = await findCollection(storage, args.collection);
    if (!col) {
      throw new Vid2ContextError('not-found', `Collection not found: ${args.collection}`, {
        hint: 'Use a collection id or name from list_collections, or pass `urls`.',
      });
    }
    for (const id of col.videoIds) {
      const c = await storage.getContext(id);
      if (c) add(c);
      else problems.push({ input: id, error: 'not-found', message: `${id} is in the collection but has no saved transcript.` });
    }
  }

  for (const input of args.urls ?? []) {
    ctx.signal?.throwIfAborted();
    let refs: { input: string }[];
    try {
      refs = (await expandInput(registry, input, ctx, { limit: MAX_VIDEOS })).map((r) => ({ input: r.url ?? r.input }));
    } catch (err) {
      const saved = err instanceof Vid2ContextError && err.code === 'unsupported-input' && storage ? await findSaved(storage, input) : null;
      if (saved) add(saved);
      else problems.push(problem(input, err));
      continue;
    }
    for (const r of refs) {
      if (contexts.length >= MAX_VIDEOS) {
        found++;
        continue;
      }
      try {
        add(await getVideoContext(registry, r.input, { storage }, ctx));
      } catch (err) {
        problems.push(problem(r.input, err));
      }
    }
  }

  return { contexts, problems, ...(found > contexts.length ? { truncated: found - contexts.length } : {}) };
}
