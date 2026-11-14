/**
 * A Storage wrapper that shares transcripts of public videos across every
 * user of a hosted instance, so the same YouTube video is transcribed once.
 *
 * Rules:
 * - Only refs on public platforms are shared (`youtube` by default; set
 *   VID2CONTEXT_SHARED_CACHE_PLATFORMS to change the list). Local files,
 *   uploads and other private inputs are never shared, whatever the list says.
 * - Nothing produced with the user's own cookies or provider keys is shared:
 *   the caller says so with `userCredentials: true`, and then the wrapper only
 *   passes through to the inner storage.
 * - Entries are keyed by ref id, transcript mode and language, and expire
 *   after a TTL (30 days by default). `refresh: true` skips the read and
 *   overwrites the entry with the new result.
 * - Every write still goes to the inner storage, so raw transcripts are kept
 *   wherever the instance keeps them.
 *
 * Keys:
 *   cache:shared:<refId>|<mode>|<language or *>   VideoContext (expires after the TTL)
 */
import {
  type Collection,
  hasKv,
  type KvStore,
  type Page,
  type SearchHit,
  type SearchQuery,
  type Storage,
  type TranscriptMode,
  type VideoContext,
  type VideoSummary,
} from '@vid2context/core';

/** Platforms whose refs are never shared: they point at one user's own media. */
export const NEVER_SHARED_PLATFORMS: readonly string[] = ['file', 'upload', 'local', 'data', 'blob'];

export interface SharedCacheOptions {
  /** Where shared entries live. Usually the instance KV (`hasKv(storage) ? storage : new MemoryKv()`). */
  kv: KvStore;
  /** True when this request fetched with the user's own cookies or provider keys: nothing it produces is shared. */
  userCredentials: boolean;
  mode?: TranscriptMode;
  /** The requested language (BCP-47), or undefined for the spoken language. */
  language?: string;
  /** Skip the shared read and overwrite the entry. */
  refresh?: boolean;
  /** Default 30 days. */
  ttlSec?: number;
  /** Default ['youtube']. */
  publicPlatforms?: string[];
  /** Called with the ref id whenever a request is served from the shared cache. */
  onHit?: (id: string) => void;
}

/** Largest context stored in the shared cache (Cloudflare KV and D1 values must stay under 1 MB). */
const MAX_JSON_BYTES = 900_000;

export function platformOf(id: string): string {
  const i = id.indexOf(':');
  return (i > 0 ? id.slice(0, i) : '').toLowerCase();
}

/** True when a ref id may be served from and written to the shared cache. */
export function isShareable(id: string, publicPlatforms: string[] = ['youtube']): boolean {
  const platform = platformOf(id);
  if (!platform || NEVER_SHARED_PLATFORMS.includes(platform)) return false;
  return publicPlatforms.map((p) => p.toLowerCase()).includes(platform);
}

export function sharedCacheKey(id: string, mode: TranscriptMode, language: string | undefined): string {
  return `cache:shared:${id}|${mode}|${language ? language.toLowerCase() : '*'}`;
}

export class SharedCacheStorage implements Storage, Partial<KvStore> {
  readonly backend: string;
  kvGet?: KvStore['kvGet'];
  kvSet?: KvStore['kvSet'];
  kvDelete?: KvStore['kvDelete'];
  kvList?: KvStore['kvList'];
  /** Hits and misses on the shared cache during this wrapper's life (one request, usually). */
  readonly stats = { hits: 0, misses: 0, writes: 0 };
  private readonly mode: TranscriptMode;
  private readonly ttlSec: number;
  private readonly platforms: string[];

  constructor(
    private readonly inner: Storage,
    private readonly opts: SharedCacheOptions,
  ) {
    this.backend = `shared-cache+${inner.backend}`;
    this.mode = opts.mode ?? 'auto';
    this.ttlSec = opts.ttlSec ?? 30 * 86_400;
    this.platforms = opts.publicPlatforms ?? ['youtube'];
    // Keep the inner backend's KV visible, so features that call hasKv() on this wrapper still find it.
    if (hasKv(inner)) {
      this.kvGet = inner.kvGet.bind(inner);
      this.kvSet = inner.kvSet.bind(inner);
      this.kvDelete = inner.kvDelete.bind(inner);
      this.kvList = inner.kvList.bind(inner);
    }
  }

  private shares(id: string): boolean {
    return !this.opts.userCredentials && isShareable(id, this.platforms);
  }

  async getContext(id: string): Promise<VideoContext | null> {
    if (!this.shares(id)) return this.inner.getContext(id);
    if (this.opts.refresh) return null;
    const hit = await this.opts.kv.kvGet<VideoContext>(sharedCacheKey(id, this.mode, this.opts.language));
    if (hit) {
      this.stats.hits++;
      this.opts.onHit?.(id);
      return hit;
    }
    this.stats.misses++;
    // The inner storage may hold a version built with someone's own keys or cookies; it is never served to others.
    return null;
  }

  async putContext(context: VideoContext): Promise<void> {
    await this.inner.putContext(context);
    const id = context.metadata.ref.id;
    if (!this.shares(id)) return;
    const json = JSON.stringify(context);
    if (json.length > MAX_JSON_BYTES) return;
    const keys = new Set([sharedCacheKey(id, this.mode, this.opts.language)]);
    // A spoken-language request also answers later requests that name that language.
    if (!this.opts.language && context.transcript.language) {
      keys.add(sharedCacheKey(id, this.mode, context.transcript.language));
    }
    for (const key of keys) await this.opts.kv.kvSet(key, context, { ttlSec: this.ttlSec });
    this.stats.writes++;
  }

  deleteContext(id: string): Promise<void> {
    return this.inner.deleteContext(id);
  }
  listContexts(opts?: { limit?: number; cursor?: string }): Promise<Page<VideoSummary>> {
    return this.inner.listContexts(opts);
  }
  createCollection(input: { name: string; description?: string; sources?: string[] }): Promise<Collection> {
    return this.inner.createCollection(input);
  }
  getCollection(id: string): Promise<Collection | null> {
    return this.inner.getCollection(id);
  }
  listCollections(): Promise<Collection[]> {
    return this.inner.listCollections();
  }
  updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'sources'>>): Promise<Collection> {
    return this.inner.updateCollection(id, patch);
  }
  addToCollection(id: string, videoIds: string[]): Promise<Collection> {
    return this.inner.addToCollection(id, videoIds);
  }
  removeFromCollection(id: string, videoIds: string[]): Promise<Collection> {
    return this.inner.removeFromCollection(id, videoIds);
  }
  deleteCollection(id: string): Promise<void> {
    return this.inner.deleteCollection(id);
  }
  search(query: SearchQuery): Promise<SearchHit[]> {
    return this.inner.search(query);
  }
}

/** Wrap a Storage so public videos are read from and written to the shared cache. */
export function sharedCache(storage: Storage, opts: SharedCacheOptions): SharedCacheStorage {
  return new SharedCacheStorage(storage, opts);
}
