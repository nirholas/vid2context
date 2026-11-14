/**
 * Optional storage extensions shared by feature packages. A Storage backend
 * may also implement KvStore (small JSON state: watch lists, jobs, API keys,
 * OAuth clients, resume checkpoints) and VectorStore (embedding search).
 * Callers detect them with hasKv / hasVectors and otherwise fall back to the
 * process-local MemoryKv / MemoryVectors below, so every feature works with
 * every backend.
 *
 * Created verbatim from docs/prompts/SHARED-CONTRACTS.md. Change it only
 * additively, and update that file in the same commit.
 */
import type { Storage } from './storage.ts';

export interface KvStore {
  kvGet<T = unknown>(key: string): Promise<T | null>;
  /** Stores a JSON-serialisable value. `ttlSec` expires it; omit it to keep the value until deleted. */
  kvSet(key: string, value: unknown, opts?: { ttlSec?: number }): Promise<void>;
  kvDelete(key: string): Promise<void>;
  /** Live keys starting with `prefix`, in lexical order. Pass the returned cursor to get the next page. */
  kvList(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<{ keys: string[]; cursor?: string }>;
}

export interface VectorRecord {
  /** Unique per chunk and model, e.g. `${videoId}#${startSec}`. */
  id: string;
  videoId: string;
  startSec: number;
  endSec: number;
  text: string;
  /** Embedding rung model id. Vectors from different models are never compared. */
  model: string;
  vector: number[];
}

export interface VectorQuery {
  vector: number[];
  model: string;
  limit?: number;
  /** Restrict to these videos (a collection's videoIds, for example). */
  videoIds?: string[];
}

export interface VectorHit {
  id: string;
  videoId: string;
  startSec: number;
  endSec: number;
  text: string;
  /** Cosine similarity, -1 to 1. */
  score: number;
}

export interface VectorStore {
  upsertVectors(records: VectorRecord[]): Promise<void>;
  deleteVectors(filter: { videoId: string; model?: string }): Promise<void>;
  queryVectors(query: VectorQuery): Promise<VectorHit[]>;
}

export function hasKv<S extends Storage>(storage: S | null | undefined): storage is S & KvStore {
  const s = storage as (S & Partial<KvStore>) | null | undefined;
  return typeof s?.kvGet === 'function' && typeof s.kvSet === 'function' && typeof s.kvList === 'function';
}

export function hasVectors<S extends Storage>(storage: S | null | undefined): storage is S & VectorStore {
  const s = storage as (S & Partial<VectorStore>) | null | undefined;
  return typeof s?.queryVectors === 'function' && typeof s.upsertVectors === 'function';
}

/** Process-local KvStore. State is lost on restart. */
export class MemoryKv implements KvStore {
  private data = new Map<string, { json: string; expiresAt?: number }>();

  async kvGet<T = unknown>(key: string): Promise<T | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return JSON.parse(entry.json) as T;
  }

  async kvSet(key: string, value: unknown, opts: { ttlSec?: number } = {}): Promise<void> {
    const expiresAt = opts.ttlSec && opts.ttlSec > 0 ? Date.now() + opts.ttlSec * 1000 : undefined;
    this.data.set(key, { json: JSON.stringify(value), expiresAt });
  }

  async kvDelete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async kvList(prefix: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ keys: string[]; cursor?: string }> {
    const now = Date.now();
    const after = opts.cursor ?? '';
    const keys = [...this.data.entries()]
      .filter(([k, e]) => k.startsWith(prefix) && k > after && (e.expiresAt === undefined || e.expiresAt > now))
      .map(([k]) => k)
      .sort();
    const limit = opts.limit ?? 100;
    const page = keys.slice(0, limit);
    return keys.length > limit ? { keys: page, cursor: page.at(-1) } : { keys: page };
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Process-local VectorStore with exact (brute-force) cosine search. Fine up to tens of thousands of chunks. */
export class MemoryVectors implements VectorStore {
  private records = new Map<string, VectorRecord>();

  async upsertVectors(records: VectorRecord[]): Promise<void> {
    for (const r of records) this.records.set(`${r.model}\u0000${r.id}`, r);
  }

  async deleteVectors(filter: { videoId: string; model?: string }): Promise<void> {
    for (const [key, r] of this.records) {
      if (r.videoId === filter.videoId && (filter.model === undefined || r.model === filter.model)) this.records.delete(key);
    }
  }

  async queryVectors(query: VectorQuery): Promise<VectorHit[]> {
    const allow = query.videoIds ? new Set(query.videoIds) : null;
    const hits: VectorHit[] = [];
    for (const r of this.records.values()) {
      if (r.model !== query.model) continue;
      if (allow && !allow.has(r.videoId)) continue;
      hits.push({
        id: r.id,
        videoId: r.videoId,
        startSec: r.startSec,
        endSec: r.endSec,
        text: r.text,
        score: cosine(query.vector, r.vector),
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, query.limit ?? 20);
  }
}
