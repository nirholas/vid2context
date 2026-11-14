/**
 * Hybrid search engine over saved transcripts.
 *
 *   index(context)   chunk the transcript into 30 to 60 s windows, add them to the
 *                    keyword index, embed them with the pinned embedding model
 *   remove(videoId)  drop one video from both sides
 *   search(request)  keyword top N + vector top N, reciprocal rank fusion,
 *                    optional LLM rerank, merge neighbouring chunks into time
 *                    ranges, highlight, attach timestamp links
 *
 * Keyword side: the storage backend's own full-text search when it has one
 * (SQLite FTS5, Postgres tsvector, D1 FTS5), else an in-memory BM25 index.
 * Vector side: the storage backend when it implements VectorStore, else
 * process-local MemoryVectors. One embedding model per index: every vector is
 * tagged with its model and vectors of different models are never compared.
 * With no embed rung enabled the engine runs keyword-only and says so.
 *
 * When a storage backend is given, search first syncs: contexts saved in the
 * library but not yet indexed by this engine (or saved again since) are
 * indexed, and contexts deleted from the library are dropped.
 */
import {
  type Attempt,
  attemptsOf,
  type Ctx,
  type EmbedRung,
  hasKv,
  hasVectors,
  type KvStore,
  MemoryKv,
  MemoryVectors,
  type Registry,
  rankRungs,
  runChain,
  type SearchHit,
  type Segment,
  type Storage,
  type TranscriptOrigin,
  timestampUrl,
  type VectorStore,
  Vid2ContextError,
  type VideoContext,
  type VideoRef,
} from '@vid2context/core';
import { Bm25Index } from './bm25.ts';
import { CHUNK_DEFAULTS, type ChunkOptions, chunkTranscript, type SearchChunk } from './chunk.ts';
import { type RankedList, reciprocalRankFusion, type SearchSide } from './fuse.ts';
import { highlight, mergeAdjacent, type RankedChunk, rangeText } from './merge.ts';
import { type ParsedQuery, parseQuery, passesConstraints } from './query.ts';
import { rerank as llmRerank } from './rerank.ts';
import { phraseWords } from './tokenize.ts';

// ---------------------------------------------------------------- types

export interface FusionOptions {
  /** RRF constant. Default 60. */
  k?: number;
  /** Weight of the keyword list. Default 1. */
  keywordWeight?: number;
  /** Weight of the vector list. Default 1. */
  vectorWeight?: number;
}

export interface SearchEngineOptions {
  registry: Registry;
  /** Library backend. Its full-text search and vector store are used when present; omitted: in-memory only. */
  storage?: Storage | null;
  /** Default context for embedding and rerank calls; each call can pass its own. */
  ctx: Ctx;
  /** Pin the embedding model: a rung model ('bge-m3'), '<service>/<model>' ('ovh/bge-m3') or a rung id. Default: the first enabled embed rung in free-first order. */
  embedModel?: string;
  /** Keyword backend. 'auto' (default) uses storage full-text search when the backend has it, else BM25. */
  keyword?: 'auto' | 'bm25' | 'storage';
  chunk?: ChunkOptions;
  /** Texts per embedding request. Default 24 (the keyless OVH endpoint accepts at most 25). */
  embedBatchSize?: number;
  fusion?: FusionOptions;
  /** Candidates taken from each side before fusion. Default 50. */
  candidates?: number;
}

export interface SearchRequest {
  query: string;
  /** Hits returned. Default 10, at most 100. */
  limit?: number;
  collectionId?: string;
  videoIds?: string[];
  /** Channel name or id, case-insensitive exact match. */
  channel?: string;
  /** ISO 8601 date or date-time; videos without a publish date are excluded when a date filter is set. */
  publishedAfter?: string;
  publishedBefore?: string;
  origin?: TranscriptOrigin | TranscriptOrigin[];
  /** 'hybrid' (default), or one side alone. */
  mode?: 'hybrid' | 'keyword' | 'vector';
  /** Rerank the fused top candidates with an LLM rung. Off by default. */
  rerank?: boolean | { top?: number };
  fusion?: FusionOptions;
}

export interface EngineHit extends SearchHit {
  /** Timestamp link to startSec, when the platform supports one. */
  url?: string;
  chapterTitle?: string;
  sources: SearchSide[];
  /** A short part of `text` with matched words in **bold**. */
  snippet: string;
  channel?: string;
  /** 1-based rank on each side for the hit's best chunk. */
  ranks: Partial<Record<SearchSide, number>>;
  /** LLM relevance 0 to 10 when reranked. */
  rerankScore?: number;
}

export type VectorStatus = 'ok' | 'partial' | 'disabled' | 'failed' | 'off';

export interface SearchMeta {
  query: { text: string; phrases: string[]; excluded: string[] };
  mode: 'hybrid' | 'keyword' | 'vector';
  keyword: { ran: boolean; backend: 'bm25' | 'storage'; candidates: number; reason?: string };
  /**
   * ok: vectors searched for every indexed video. partial: some videos have no
   * vectors yet (embedding failed or was rate limited; retried on the next
   * search). disabled: no embed rung is enabled, keyword-only. failed: the
   * query could not be embedded, keyword-only. off: mode is 'keyword'.
   */
  vector: VectorStatus;
  vectorReason?: string;
  model?: string;
  vectorCoverage?: { videos: number; withVectors: number };
  rerank: 'off' | 'ok' | 'failed';
  rerankRung?: string;
  rerankReason?: string;
  fusion: { k: number; keywordWeight: number; vectorWeight: number };
  indexed: { videos: number; chunks: number };
  /** Videos re-indexed during this search because the embedding model changed. */
  reindexed?: { videoId: string; from: string; to: string }[];
  timings: { syncMs: number; keywordMs: number; vectorMs: number; rerankMs: number; totalMs: number };
  attempts: Attempt[];
}

export interface SearchResult {
  hits: EngineHit[];
  meta: SearchMeta;
}

export interface IndexResult {
  videoId: string;
  chunks: number;
  /**
   * indexed: embedded now. reused: vectors for this exact transcript and model
   * already stored. disabled: no embed rung enabled. failed: embedding failed,
   * keyword search still works and the next index or search retries.
   */
  vector: 'indexed' | 'reused' | 'disabled' | 'failed';
  model?: string;
  /** Set when the video had vectors from another model, which were replaced. */
  reindexedFrom?: string;
  reason?: string;
  attempts: Attempt[];
}

export interface SearchEngine {
  index(context: VideoContext, opts?: { ctx?: Ctx }): Promise<IndexResult>;
  remove(videoId: string): Promise<void>;
  search(request: SearchRequest, opts?: { ctx?: Ctx }): Promise<SearchResult>;
  /** The embedding model the engine would use with this context's env, or null when none is enabled. */
  embedModel(ctx?: Ctx): string | null;
  stats(): { videos: number; chunks: number; keyword: 'bm25' | 'storage'; vectors: 'storage' | 'memory' };
}

interface VideoEntry {
  videoId: string;
  ref: VideoRef;
  title: string;
  channelName?: string;
  channelId?: string;
  publishedAt?: string;
  origin: TranscriptOrigin;
  segments: Segment[];
  chunks: Map<string, SearchChunk & { words: string[] }>;
  hash: string;
  /** Model whose vectors are stored for this transcript, or null. */
  vectorModel: string | null;
  /** savedAt from the library when this entry came from a storage sync. */
  savedAt?: string;
}

interface Manifest {
  model: string;
  hash: string;
  chunks: number;
  indexedAt: string;
}

/** Storage backends whose `search` is real full-text search. */
const FTS_BACKENDS = /sqlite|d1|postgres|pg/i;
const MANIFEST_PREFIX = 'search:v1:manifest:';

// ---------------------------------------------------------------- helpers

/** '<service without #n>/<model>': the same model from the same service gives the same vectors, whichever pooled key served it. */
export function embedModelKey(rung: EmbedRung): string {
  return `${rung.service.replace(/#\d+$/, '')}/${rung.model}`;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function errorReason(err: unknown): string {
  if (err instanceof Vid2ContextError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function parseDate(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) {
    throw new Vid2ContextError('bad-request', `${name} is not a date: ${v}`, {
      hint: 'Use an ISO 8601 date such as 2024-05-01.',
    });
  }
  return t;
}

// ---------------------------------------------------------------- engine

export function createSearchEngine(options: SearchEngineOptions): SearchEngine {
  return new HybridSearchEngine(options);
}

class HybridSearchEngine implements SearchEngine {
  private readonly registry: Registry;
  private readonly storage: Storage | null;
  private readonly ctx: Ctx;
  private readonly pinned?: string;
  private readonly keywordMode: 'bm25' | 'storage';
  private readonly chunkOpts: ChunkOptions;
  private readonly batchSize: number;
  private readonly fusion: Required<FusionOptions>;
  private readonly candidates: number;
  private readonly vectors: VectorStore;
  private readonly manifests: KvStore;
  private readonly bm25 = new Bm25Index();
  private readonly videos = new Map<string, VideoEntry>();
  private syncing: Promise<{ reindexed: { videoId: string; from: string; to: string }[]; attempts: Attempt[] }> | null = null;

  constructor(o: SearchEngineOptions) {
    this.registry = o.registry;
    this.storage = o.storage ?? null;
    this.ctx = o.ctx;
    this.pinned = o.embedModel?.trim() || undefined;
    const wantStorage =
      o.keyword === 'storage' || ((o.keyword ?? 'auto') === 'auto' && !!this.storage && FTS_BACKENDS.test(this.storage.backend));
    if (o.keyword === 'storage' && !this.storage) {
      throw new Vid2ContextError('bad-request', 'keyword: "storage" needs a storage backend.', {
        hint: 'Pass storage, or use keyword: "auto" or "bm25".',
      });
    }
    this.keywordMode = wantStorage ? 'storage' : 'bm25';
    this.chunkOpts = { ...CHUNK_DEFAULTS, ...o.chunk };
    this.batchSize = clampInt(o.embedBatchSize, 24, 1, 2048);
    this.fusion = {
      k: o.fusion?.k ?? 60,
      keywordWeight: o.fusion?.keywordWeight ?? 1,
      vectorWeight: o.fusion?.vectorWeight ?? 1,
    };
    this.candidates = clampInt(o.candidates, 50, 5, 1000);
    const persistent = hasVectors(this.storage);
    this.vectors = persistent ? (this.storage as Storage & VectorStore) : new MemoryVectors();
    // The manifest says which transcript and model the stored vectors belong to, so it lives with the vectors.
    this.manifests = persistent && hasKv(this.storage) ? (this.storage as Storage & KvStore) : new MemoryKv();
  }

  stats() {
    let chunks = 0;
    for (const v of this.videos.values()) chunks += v.chunks.size;
    return {
      videos: this.videos.size,
      chunks,
      keyword: this.keywordMode,
      vectors: hasVectors(this.storage) ? ('storage' as const) : ('memory' as const),
    };
  }

  // ------------------------------------------------------------ embedding

  private embedRungs(ctx: Ctx): { model: string; rungs: EmbedRung[] } | { reason: string } {
    const all = this.registry.embedRungs(ctx.env);
    const ranked = rankRungs(all, {}, ctx.env);
    if (this.pinned) {
      const p = this.pinned;
      const matching = ranked.filter((r) => r.model === p || embedModelKey(r) === p || r.id === p);
      const first = matching[0];
      if (!first) {
        return { reason: `The pinned embedding model "${p}" has no enabled rung.` };
      }
      const model = embedModelKey(first);
      return { model, rungs: matching.filter((r) => embedModelKey(r) === model) };
    }
    const first = ranked[0];
    if (!first) {
      return {
        reason:
          all.length === 0
            ? 'No embedding provider is installed.'
            : 'No embed rung is enabled (set a key from docs/providers.md, or allow keyless rungs).',
      };
    }
    const model = embedModelKey(first);
    return { model, rungs: ranked.filter((r) => embedModelKey(r) === model) };
  }

  embedModel(ctx: Ctx = this.ctx): string | null {
    const r = this.embedRungs(ctx);
    return 'model' in r ? r.model : null;
  }

  private async embed(texts: string[], rungs: EmbedRung[], ctx: Ctx, attempts: Attempt[]): Promise<number[][]> {
    const out: number[][] = [];
    const only = rungs.map((r) => r.id);
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      try {
        const res = await runChain('embed', rungs, (r) => r.embed(batch, ctx), { only }, ctx);
        attempts.push(...res.attempts);
        if (res.value.length !== batch.length) {
          throw new Vid2ContextError('upstream', `Embedding returned ${res.value.length} vectors for ${batch.length} texts.`, {
            hint: 'Retry; if it persists, pin another embedding model.',
          });
        }
        out.push(...res.value);
      } catch (err) {
        attempts.push(...attemptsOf(err));
        throw err;
      }
    }
    return out;
  }

  // ------------------------------------------------------------ indexing

  private buildEntry(context: VideoContext): VideoEntry {
    const chunks = chunkTranscript(context, this.chunkOpts);
    const hash = fnv1a(JSON.stringify([this.chunkOpts, chunks.map((c) => [c.id, c.endSec, c.text])]));
    return {
      videoId: context.metadata.ref.id,
      ref: context.metadata.ref,
      title: context.metadata.title,
      channelName: context.metadata.channel?.name,
      channelId: context.metadata.channel?.id,
      publishedAt: context.metadata.publishedAt,
      origin: context.transcript.origin,
      segments: context.transcript.segments,
      chunks: new Map(chunks.map((c) => [c.id, { ...c, words: phraseWords(c.text) }])),
      hash,
      vectorModel: null,
    };
  }

  private putKeyword(entry: VideoEntry): void {
    const previous = this.videos.get(entry.videoId);
    if (previous) this.bm25.removeGroup(entry.videoId);
    for (const c of entry.chunks.values()) this.bm25.add(c.id, entry.videoId, c.text);
    this.videos.set(entry.videoId, entry);
  }

  async index(context: VideoContext, opts: { ctx?: Ctx } = {}): Promise<IndexResult> {
    if (!context?.metadata?.ref?.id || !Array.isArray(context.transcript?.segments)) {
      throw new Vid2ContextError('bad-request', 'index() needs a VideoContext with metadata.ref.id and transcript.segments.', {
        hint: 'Pass the object returned by getVideoContext or saved in storage.',
      });
    }
    const entry = this.buildEntry(context);
    this.putKeyword(entry);
    return this.indexVectors(entry, opts.ctx ?? this.ctx);
  }

  private async indexVectors(entry: VideoEntry, ctx: Ctx): Promise<IndexResult> {
    const attempts: Attempt[] = [];
    const base = { videoId: entry.videoId, chunks: entry.chunks.size, attempts };
    const embed = this.embedRungs(ctx);
    if ('reason' in embed) return { ...base, vector: 'disabled', reason: embed.reason };
    const key = MANIFEST_PREFIX + entry.videoId;
    const manifest = await this.manifests.kvGet<Manifest>(key);
    if (manifest && manifest.model === embed.model && manifest.hash === entry.hash) {
      entry.vectorModel = embed.model;
      return { ...base, vector: 'reused', model: embed.model };
    }
    const chunks = [...entry.chunks.values()];
    try {
      const vectors =
        chunks.length > 0
          ? await this.embed(
              chunks.map((c) => c.text),
              embed.rungs,
              ctx,
              attempts,
            )
          : [];
      // One model per index: drop every older vector of this video, whatever its model.
      await this.vectors.deleteVectors({ videoId: entry.videoId });
      await this.vectors.upsertVectors(
        chunks.map((c, i) => ({
          id: c.id,
          videoId: entry.videoId,
          startSec: c.startSec,
          endSec: c.endSec,
          text: c.text,
          model: embed.model,
          vector: vectors[i] as number[],
        })),
      );
      await this.manifests.kvSet(key, {
        model: embed.model,
        hash: entry.hash,
        chunks: chunks.length,
        indexedAt: new Date().toISOString(),
      } satisfies Manifest);
      entry.vectorModel = embed.model;
      const reindexedFrom = manifest && manifest.model !== embed.model ? manifest.model : undefined;
      if (reindexedFrom) {
        ctx.log.info('search: re-indexed vectors with a new embedding model', {
          videoId: entry.videoId,
          from: reindexedFrom,
          to: embed.model,
        });
      }
      return { ...base, vector: 'indexed', model: embed.model, ...(reindexedFrom ? { reindexedFrom } : {}) };
    } catch (err) {
      if (manifest && manifest.hash !== entry.hash) {
        // The stored vectors describe an older transcript; drop them rather than return stale text.
        await this.vectors.deleteVectors({ videoId: entry.videoId });
        await this.manifests.kvDelete(key);
      } else if (manifest && manifest.model === embed.model) {
        entry.vectorModel = manifest.model;
      }
      ctx.log.warn('search: embedding failed, keyword search still works for this video', {
        videoId: entry.videoId,
        reason: errorReason(err),
      });
      return { ...base, vector: 'failed', model: embed.model, reason: errorReason(err) };
    }
  }

  async remove(videoId: string): Promise<void> {
    this.bm25.removeGroup(videoId);
    this.videos.delete(videoId);
    await this.vectors.deleteVectors({ videoId });
    await this.manifests.kvDelete(MANIFEST_PREFIX + videoId);
  }

  // ------------------------------------------------------------ storage sync

  private sync(ctx: Ctx, embed: boolean) {
    if (!this.syncing) {
      this.syncing = this.runSync(ctx, embed).finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async runSync(ctx: Ctx, embed: boolean) {
    const reindexed: { videoId: string; from: string; to: string }[] = [];
    const attempts: Attempt[] = [];
    const storage = this.storage;
    if (!storage) return { reindexed, attempts };
    const seen = new Set<string>();
    const stale: VideoEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await storage.listContexts({ limit: 200, cursor });
      for (const s of page.items) {
        seen.add(s.id);
        const have = this.videos.get(s.id);
        if (have && (have.savedAt === undefined || have.savedAt === s.savedAt)) continue;
        const context = await storage.getContext(s.id);
        if (!context) continue;
        const entry = this.buildEntry(context);
        entry.savedAt = s.savedAt;
        this.putKeyword(entry);
        stale.push(entry);
      }
      cursor = page.cursor;
    } while (cursor);
    for (const [id, v] of this.videos) {
      if (v.savedAt !== undefined && !seen.has(id)) await this.remove(id);
    }
    if (!embed) return { reindexed, attempts };
    const model = this.embedModel(ctx);
    if (!model) return { reindexed, attempts };
    // Videos without vectors for the current model: new ones, and ones indexed under another model.
    for (const v of this.videos.values()) if (v.vectorModel !== model && !stale.includes(v)) stale.push(v);
    for (const entry of stale) {
      const res = await this.indexVectors(entry, ctx);
      attempts.push(...res.attempts);
      if (res.reindexedFrom) reindexed.push({ videoId: entry.videoId, from: res.reindexedFrom, to: model });
      // Stop embedding on the first failure (usually a rate limit); the rest are retried on the next search.
      if (res.vector === 'failed') break;
    }
    return { reindexed, attempts };
  }

  // ------------------------------------------------------------ search

  private async allowedVideos(req: SearchRequest): Promise<Set<string> | null> {
    let ids: Set<string> | null = null;
    const narrow = (next: Iterable<string>) => {
      const n = new Set(next);
      ids = ids ? new Set([...ids].filter((x) => n.has(x))) : n;
    };
    if (req.collectionId) {
      if (!this.storage) {
        throw new Vid2ContextError('bad-request', 'Collection filters need a storage backend.', {
          hint: 'Create the engine with storage, or filter by videoIds.',
        });
      }
      const c = await this.storage.getCollection(req.collectionId);
      if (!c) {
        throw new Vid2ContextError('not-found', `Collection not found: ${req.collectionId}`, {
          hint: 'List collections to see valid ids.',
        });
      }
      narrow(c.videoIds);
    }
    if (req.videoIds && req.videoIds.length > 0) narrow(req.videoIds);
    const channel = req.channel?.trim().toLowerCase();
    const after = parseDate(req.publishedAfter, 'publishedAfter');
    const before = parseDate(req.publishedBefore, 'publishedBefore');
    const origins = req.origin ? new Set(Array.isArray(req.origin) ? req.origin : [req.origin]) : null;
    if (channel || after !== undefined || before !== undefined || origins) {
      const ok: string[] = [];
      for (const v of this.videos.values()) {
        if (channel && v.channelName?.toLowerCase() !== channel && v.channelId?.toLowerCase() !== channel) continue;
        if (origins && !origins.has(v.origin)) continue;
        if (after !== undefined || before !== undefined) {
          const t = v.publishedAt ? Date.parse(v.publishedAt) : Number.NaN;
          if (Number.isNaN(t)) continue;
          if (after !== undefined && t < after) continue;
          if (before !== undefined && t > before) continue;
        }
        ok.push(v.videoId);
      }
      narrow(ok);
    }
    return ids;
  }

  private chunkOf(id: string): { video: VideoEntry; chunk: SearchChunk & { words: string[] } } | null {
    const hash = id.lastIndexOf('#');
    const video = hash > 0 ? this.videos.get(id.slice(0, hash)) : undefined;
    const chunk = video?.chunks.get(id);
    return video && chunk ? { video, chunk } : null;
  }

  private async keywordSide(
    q: ParsedQuery,
    allowed: Set<string> | null,
    accept: (id: string) => boolean,
    meta: SearchMeta,
  ): Promise<string[]> {
    if (q.terms.length === 0) return [];
    if (this.keywordMode === 'storage' && this.storage) {
      try {
        const hits = await this.storage.search({
          text: q.text,
          ...(allowed ? { videoIds: [...allowed] } : {}),
          limit: this.candidates * 4,
        });
        const ids: string[] = [];
        for (const h of hits) {
          const video = this.videos.get(h.videoId);
          if (!video) continue;
          // Map the backend's hit (often one segment) to the indexed chunk it overlaps most.
          let best: string | null = null;
          let bestOverlap = 0;
          for (const c of video.chunks.values()) {
            const overlap = Math.min(c.endSec, h.endSec) - Math.max(c.startSec, h.startSec);
            if (overlap > bestOverlap || (best === null && overlap >= 0)) {
              best = c.id;
              bestOverlap = overlap;
            }
          }
          if (best && !ids.includes(best) && accept(best)) ids.push(best);
          if (ids.length >= this.candidates) break;
        }
        meta.keyword.backend = 'storage';
        return ids;
      } catch (err) {
        meta.keyword.reason = `storage search failed, used BM25: ${errorReason(err)}`;
      }
    }
    meta.keyword.backend = 'bm25';
    return this.bm25
      .search(q.terms, {
        limit: this.candidates,
        allow: (id, group) => (!allowed || allowed.has(group)) && accept(id),
      })
      .map((h) => h.id);
  }

  async search(req: SearchRequest, opts: { ctx?: Ctx } = {}): Promise<SearchResult> {
    const ctx = opts.ctx ?? this.ctx;
    const started = Date.now();
    if (typeof req?.query !== 'string' || req.query.trim() === '') {
      throw new Vid2ContextError('bad-request', 'The search query is empty.', { hint: 'Pass some words to search for.' });
    }
    const q = parseQuery(req.query);
    const mode = req.mode ?? 'hybrid';
    const limit = clampInt(req.limit, 10, 1, 100);
    const fusion = {
      k: req.fusion?.k ?? this.fusion.k,
      keywordWeight: req.fusion?.keywordWeight ?? this.fusion.keywordWeight,
      vectorWeight: req.fusion?.vectorWeight ?? this.fusion.vectorWeight,
    };
    const meta: SearchMeta = {
      query: { text: q.text, phrases: q.display.phrases, excluded: q.display.excluded },
      mode,
      keyword: { ran: false, backend: this.keywordMode, candidates: 0 },
      vector: mode === 'keyword' ? 'off' : 'ok',
      rerank: 'off',
      fusion,
      indexed: { videos: 0, chunks: 0 },
      timings: { syncMs: 0, keywordMs: 0, vectorMs: 0, rerankMs: 0, totalMs: 0 },
      attempts: [],
    };

    const synced = await this.sync(ctx, mode !== 'keyword');
    meta.attempts.push(...synced.attempts);
    if (synced.reindexed.length > 0) meta.reindexed = synced.reindexed;
    meta.timings.syncMs = Date.now() - started;
    const s = this.stats();
    meta.indexed = { videos: s.videos, chunks: s.chunks };

    const allowed = await this.allowedVideos(req);
    const accept = (id: string) => {
      const found = this.chunkOf(id);
      return !!found && (!allowed || allowed.has(found.video.videoId)) && passesConstraints(q, found.chunk.words);
    };

    const lists: RankedList[] = [];
    if (mode !== 'vector') {
      const t = Date.now();
      const ids = await this.keywordSide(q, allowed, accept, meta);
      meta.keyword.ran = true;
      meta.keyword.candidates = ids.length;
      meta.timings.keywordMs = Date.now() - t;
      lists.push({ side: 'keyword', ids, weight: fusion.keywordWeight });
    }

    if (mode !== 'keyword') {
      const t = Date.now();
      const embed = this.embedRungs(ctx);
      if ('reason' in embed) {
        meta.vector = 'disabled';
        meta.vectorReason = embed.reason;
      } else if (q.text === '') {
        meta.vector = 'failed';
        meta.vectorReason = 'The query has only excluded terms; nothing to embed.';
      } else {
        meta.model = embed.model;
        const inScope = [...this.videos.values()].filter((v) => !allowed || allowed.has(v.videoId));
        const covered = inScope.filter((v) => v.vectorModel === embed.model);
        meta.vectorCoverage = { videos: inScope.length, withVectors: covered.length };
        if (covered.length < inScope.length) {
          meta.vector = 'partial';
          meta.vectorReason = `${inScope.length - covered.length} of ${inScope.length} videos have no vectors yet; they are embedded on a later index or search.`;
        }
        if (covered.length > 0) {
          const attempts: Attempt[] = [];
          try {
            const [vector] = await this.embed([q.text], embed.rungs, ctx, attempts);
            const hits = await this.vectors.queryVectors({
              vector: vector as number[],
              model: embed.model,
              limit: this.candidates * 2,
              videoIds: covered.map((v) => v.videoId),
            });
            const ids = hits
              .map((h) => h.id)
              .filter(accept)
              .slice(0, this.candidates);
            lists.push({ side: 'vector', ids, weight: fusion.vectorWeight });
          } catch (err) {
            meta.vector = 'failed';
            meta.vectorReason = `The query could not be embedded, results are keyword-only: ${errorReason(err)}`;
          }
          meta.attempts.push(...attempts);
        }
      }
      meta.timings.vectorMs = Date.now() - t;
    }

    let fused = reciprocalRankFusion(lists, fusion.k);

    let rerankScores: Map<string, number> | null = null;
    if (req.rerank) {
      const top = clampInt(typeof req.rerank === 'object' ? req.rerank.top : undefined, 20, 2, 50);
      const head = fused.slice(0, top);
      const t = Date.now();
      if (head.length > 1) {
        try {
          const res = await llmRerank(
            this.registry,
            q.text || q.raw,
            head.map((f) => {
              const found = this.chunkOf(f.id);
              return { id: f.id, title: found?.video.title ?? '', text: found?.chunk.text ?? '' };
            }),
            ctx,
          );
          rerankScores = res.scores;
          meta.rerank = 'ok';
          meta.rerankRung = res.rung;
          const pos = new Map(head.map((f, i) => [f.id, i]));
          const reordered = [...head].sort(
            (a, b) => (res.scores.get(b.id) ?? -1) - (res.scores.get(a.id) ?? -1) || (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0),
          );
          fused = [...reordered, ...fused.slice(top)];
        } catch (err) {
          meta.attempts.push(...attemptsOf(err));
          meta.rerank = 'failed';
          meta.rerankReason = `Kept the fused order: ${errorReason(err)}`;
        }
      } else {
        meta.rerank = 'ok';
      }
      meta.timings.rerankMs = Date.now() - t;
    }

    // Merge neighbours among a generous head of the ranking, then cut to the limit.
    const ranked: (RankedChunk & { ranks: Partial<Record<SearchSide, number>> })[] = [];
    for (const f of fused.slice(0, Math.max(limit * 4, 20))) {
      const found = this.chunkOf(f.id);
      if (!found) continue;
      const c = found.chunk;
      ranked.push({
        id: c.id,
        videoId: found.video.videoId,
        startSec: c.startSec,
        endSec: c.endSec,
        segmentRange: c.segmentRange,
        ...(c.chapterTitle ? { chapterTitle: c.chapterTitle } : {}),
        score: f.score,
        sources: f.sources,
        ranks: f.ranks,
      });
    }
    const ranksById = new Map(ranked.map((r) => [r.id, r.ranks]));
    const merged = mergeAdjacent(ranked).slice(0, limit);

    const hits: EngineHit[] = merged.map((m) => {
      const video = this.videos.get(m.videoId) as VideoEntry;
      const text = rangeText(video.segments, m.segmentRange);
      const best = m.chunkIds[0] as string;
      const url = timestampUrl(video.ref, m.startSec);
      const rr = rerankScores?.get(best);
      return {
        videoId: m.videoId,
        title: video.title,
        startSec: m.startSec,
        endSec: m.endSec,
        text,
        score: m.score,
        ...(url ? { url } : {}),
        ...(m.chapterTitle ? { chapterTitle: m.chapterTitle } : {}),
        sources: m.sources,
        snippet: highlight(text, q.terms),
        ...(video.channelName ? { channel: video.channelName } : {}),
        ranks: ranksById.get(best) ?? {},
        ...(rr !== undefined ? { rerankScore: rr } : {}),
      };
    });
    meta.timings.totalMs = Date.now() - started;
    return { hits, meta };
  }
}
