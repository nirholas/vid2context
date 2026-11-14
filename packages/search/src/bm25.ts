/**
 * In-memory Okapi BM25 over transcript chunks, used when the storage backend
 * has no real full-text search (MemoryStorage, the browser). Documents can be
 * added and removed one video at a time; document frequencies are kept
 * incrementally so a re-index of one video never rebuilds the rest.
 *
 * score(d, q) = sum over query terms t of
 *   idf(t) * tf(t, d) * (k1 + 1) / (tf(t, d) + k1 * (1 - b + b * |d| / avgdl))
 * idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
 */
import { indexTerms } from './tokenize.ts';

export interface Bm25Options {
  /** Term frequency saturation. Default 1.2. */
  k1?: number;
  /** Length normalization. Default 0.75. */
  b?: number;
}

interface Doc {
  id: string;
  group: string;
  tf: Map<string, number>;
  length: number;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private docs = new Map<string, Doc>();
  private byGroup = new Map<string, Set<string>>();
  private df = new Map<string, number>();
  private totalLength = 0;

  constructor(opts: Bm25Options = {}) {
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
  }

  get size(): number {
    return this.docs.size;
  }

  /** Add or replace one document. `group` is the video id, so removeGroup drops a whole video. */
  add(id: string, group: string, text: string): void {
    this.remove(id);
    const tf = new Map<string, number>();
    const list = indexTerms(text);
    for (const t of list) tf.set(t, (tf.get(t) ?? 0) + 1);
    const doc: Doc = { id, group, tf, length: list.length };
    this.docs.set(id, doc);
    let ids = this.byGroup.get(group);
    if (!ids) {
      ids = new Set();
      this.byGroup.set(group, ids);
    }
    ids.add(id);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.totalLength += doc.length;
  }

  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.docs.delete(id);
    this.byGroup.get(doc.group)?.delete(id);
    for (const t of doc.tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1;
      if (n <= 0) this.df.delete(t);
      else this.df.set(t, n);
    }
    this.totalLength -= doc.length;
  }

  removeGroup(group: string): void {
    for (const id of [...(this.byGroup.get(group) ?? [])]) this.remove(id);
    this.byGroup.delete(group);
  }

  idf(term: string): number {
    const n = this.docs.size;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * Score documents against already-tokenized query terms (repeats count once).
   * `allow` restricts scoring to some documents; documents with score 0 are left out.
   */
  search(queryTerms: string[], opts: { limit?: number; allow?: (id: string, group: string) => boolean } = {}): Bm25Hit[] {
    const unique = [...new Set(queryTerms)];
    if (unique.length === 0 || this.docs.size === 0) return [];
    const avgdl = this.totalLength / this.docs.size || 1;
    const idfs = unique.map((t) => [t, this.idf(t)] as const).filter(([t]) => this.df.has(t));
    if (idfs.length === 0) return [];
    const hits: Bm25Hit[] = [];
    for (const doc of this.docs.values()) {
      if (opts.allow && !opts.allow(doc.id, doc.group)) continue;
      let score = 0;
      for (const [t, idf] of idfs) {
        const f = doc.tf.get(t);
        if (!f) continue;
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * doc.length) / avgdl));
      }
      if (score > 0) hits.push({ id: doc.id, score });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, opts.limit ?? 50);
  }
}
