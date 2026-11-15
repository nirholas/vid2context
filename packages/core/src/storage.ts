/**
 * Storage contract for the personal library: saved video contexts and
 * collections. Backends live in providers/storage-* (SQLite, Cloudflare D1,
 * Postgres). MemoryStorage below is the zero-dependency backend used when no
 * persistent backend is configured (single process, lost on restart).
 */
import { Vid2ContextError } from './errors.ts';
import type { VideoContext, VideoRef } from './types.ts';

export interface VideoSummary {
  id: string;
  ref: VideoRef;
  title: string;
  channel?: string;
  durationSec?: number;
  origin: VideoContext['transcript']['origin'];
  language: string;
  /** ISO 8601 of when it was saved. */
  savedAt: string;
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  /** Playlist/channel/feed inputs this collection follows. */
  sources: string[];
  videoIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SearchQuery {
  text: string;
  collectionId?: string;
  videoIds?: string[];
  limit?: number;
}

export interface SearchHit {
  videoId: string;
  title: string;
  startSec: number;
  endSec: number;
  text: string;
  score: number;
}

export interface Page<T> {
  items: T[];
  cursor?: string;
}

export interface Storage {
  readonly backend: string;
  getContext(id: string): Promise<VideoContext | null>;
  putContext(context: VideoContext): Promise<void>;
  deleteContext(id: string): Promise<void>;
  listContexts(opts?: { limit?: number; cursor?: string }): Promise<Page<VideoSummary>>;

  createCollection(input: { name: string; description?: string; sources?: string[] }): Promise<Collection>;
  getCollection(id: string): Promise<Collection | null>;
  listCollections(): Promise<Collection[]>;
  updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'sources'>>): Promise<Collection>;
  addToCollection(id: string, videoIds: string[]): Promise<Collection>;
  removeFromCollection(id: string, videoIds: string[]): Promise<Collection>;
  deleteCollection(id: string): Promise<void>;

  /** Keyword search over saved transcripts. Backends with FTS or vectors do better than MemoryStorage. */
  search(query: SearchQuery): Promise<SearchHit[]>;
}

export function summarize(context: VideoContext, savedAt: string): VideoSummary {
  return {
    id: context.metadata.ref.id,
    ref: context.metadata.ref,
    title: context.metadata.title,
    channel: context.metadata.channel?.name,
    durationSec: context.metadata.durationSec,
    origin: context.transcript.origin,
    language: context.transcript.language,
    savedAt,
  };
}

function slugId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  const rand = crypto.getRandomValues(new Uint8Array(4));
  return `${slug || 'collection'}-${Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Default cap on contexts a MemoryStorage keeps. A long video's context is a few MB, so this bounds memory to the low hundreds of MB. */
export const MEMORY_STORAGE_MAX_CONTEXTS = 200;

export interface MemoryStorageOptions {
  /** Most contexts to keep. The least recently used ones not in any collection are dropped first. Default 200. */
  maxContexts?: number;
}

/**
 * Process-local Storage. It is the fallback cache of a public server with no
 * database, so it is bounded: past `maxContexts` the least recently read or
 * written context is evicted, preferring ones no collection lists. An evicted
 * video is simply fetched again on its next request.
 */
export class MemoryStorage implements Storage {
  readonly backend = 'memory';
  /** Map order is recency order: oldest first. */
  private contexts = new Map<string, { context: VideoContext; savedAt: string }>();
  private collections = new Map<string, Collection>();
  private readonly maxContexts: number;

  constructor(opts: MemoryStorageOptions = {}) {
    const max = opts.maxContexts ?? MEMORY_STORAGE_MAX_CONTEXTS;
    this.maxContexts = Number.isFinite(max) && max >= 1 ? Math.floor(max) : MEMORY_STORAGE_MAX_CONTEXTS;
  }

  async getContext(id: string): Promise<VideoContext | null> {
    const entry = this.contexts.get(id);
    if (!entry) return null;
    this.contexts.delete(id);
    this.contexts.set(id, entry);
    return entry.context;
  }

  async putContext(context: VideoContext): Promise<void> {
    const id = context.metadata.ref.id;
    this.contexts.delete(id);
    this.contexts.set(id, { context, savedAt: new Date().toISOString() });
    this.evict();
  }

  private evict(): void {
    if (this.contexts.size <= this.maxContexts) return;
    const pinned = new Set<string>();
    for (const c of this.collections.values()) for (const v of c.videoIds) pinned.add(v);
    for (const id of this.contexts.keys()) {
      if (this.contexts.size <= this.maxContexts) return;
      if (!pinned.has(id)) this.contexts.delete(id);
    }
    // Every remaining context is in a collection: drop the oldest anyway so memory stays bounded.
    for (const id of this.contexts.keys()) {
      if (this.contexts.size <= this.maxContexts) return;
      this.contexts.delete(id);
    }
  }

  async deleteContext(id: string): Promise<void> {
    this.contexts.delete(id);
    for (const c of this.collections.values()) {
      if (c.videoIds.includes(id)) c.videoIds = c.videoIds.filter((v) => v !== id);
    }
  }

  async listContexts(opts: { limit?: number; cursor?: string } = {}): Promise<Page<VideoSummary>> {
    const all = [...this.contexts.values()]
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .map((e) => summarize(e.context, e.savedAt));
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = opts.limit ?? 50;
    const items = all.slice(start, start + limit);
    const next = start + limit < all.length ? String(start + limit) : undefined;
    return { items, cursor: next };
  }

  async createCollection(input: { name: string; description?: string; sources?: string[] }): Promise<Collection> {
    const now = new Date().toISOString();
    const c: Collection = {
      id: slugId(input.name),
      name: input.name,
      description: input.description,
      sources: input.sources ?? [],
      videoIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.collections.set(c.id, c);
    return c;
  }

  async getCollection(id: string): Promise<Collection | null> {
    return this.collections.get(id) ?? null;
  }

  async listCollections(): Promise<Collection[]> {
    return [...this.collections.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private must(id: string): Collection {
    const c = this.collections.get(id);
    if (!c) {
      throw new Vid2ContextError('not-found', `Collection not found: ${id}`, {
        hint: 'List collections to see valid ids.',
      });
    }
    return c;
  }

  async updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'sources'>>): Promise<Collection> {
    const c = this.must(id);
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    return c;
  }

  async addToCollection(id: string, videoIds: string[]): Promise<Collection> {
    const c = this.must(id);
    for (const v of videoIds) if (!c.videoIds.includes(v)) c.videoIds.push(v);
    c.updatedAt = new Date().toISOString();
    return c;
  }

  async removeFromCollection(id: string, videoIds: string[]): Promise<Collection> {
    const c = this.must(id);
    c.videoIds = c.videoIds.filter((v) => !videoIds.includes(v));
    c.updatedAt = new Date().toISOString();
    return c;
  }

  async deleteCollection(id: string): Promise<void> {
    this.collections.delete(id);
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const terms = query.text.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    let ids = [...this.contexts.keys()];
    if (query.collectionId) ids = this.collections.get(query.collectionId)?.videoIds ?? [];
    if (query.videoIds) ids = ids.filter((id) => query.videoIds?.includes(id));
    const hits: SearchHit[] = [];
    for (const id of ids) {
      const entry = this.contexts.get(id);
      if (!entry) continue;
      for (const seg of entry.context.transcript.segments) {
        const text = seg.text.toLowerCase();
        const matched = terms.filter((t) => text.includes(t)).length;
        if (matched === 0) continue;
        hits.push({
          videoId: id,
          title: entry.context.metadata.title,
          startSec: seg.startSec,
          endSec: seg.endSec,
          text: seg.text,
          score: matched / terms.length,
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.startSec - b.startSec).slice(0, query.limit ?? 20);
  }
}
