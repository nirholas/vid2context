/**
 * SqliteStorage: the persistent local library. Implements Storage (contexts,
 * collections, search), KvStore and VectorStore on one node:sqlite
 * connection. Behaviour mirrors MemoryStorage in packages/core/src/storage.ts.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  type Collection,
  type KvStore,
  type Page,
  type SearchHit,
  type SearchQuery,
  type Storage,
  summarize,
  type VectorHit,
  type VectorQuery,
  type VectorRecord,
  type VectorStore,
  Vid2ContextError,
  type VideoContext,
  type VideoSummary,
} from '@vid2context/core';
import { type OpenOptions, openDatabase, transaction } from './db.ts';
import { likePattern, parseSearch, type SearchTerm, toMatchExpression } from './query.ts';

type Row = Record<string, SQLInputValue>;

const open = new Set<SqliteStorage>();
let exitHookInstalled = false;

/** One process exit hook closes every connection still open, so WAL files are checkpointed and removed. */
function track(storage: SqliteStorage): void {
  open.add(storage);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const s of [...open]) s.close();
  });
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

function notFound(id: string): Vid2ContextError {
  return new Vid2ContextError('not-found', `Collection not found: ${id}`, {
    hint: 'List collections to see valid ids.',
  });
}

function encodeCursor(savedAt: string, id: string): string {
  return Buffer.from(JSON.stringify([savedAt, id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string')) {
      return value as [string, string];
    }
  } catch {
    // fall through to the error below
  }
  throw new Vid2ContextError('bad-request', 'Invalid library cursor.', {
    hint: 'Pass the cursor exactly as the previous page returned it, or omit it to start from the newest video.',
  });
}

function toBlob(vector: number[]): Uint8Array {
  const f = Float32Array.from(vector);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

function fromBlob(blob: Uint8Array): Float32Array {
  // Copy: the BLOB buffer may not be 4-byte aligned.
  const copy = blob.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

function norm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] as number) * (v[i] as number);
  return Math.sqrt(s);
}

/** bm25 is negative and unbounded (more negative is better); map it to 0..1, higher is better. */
function normalizeBm25(rank: number): number {
  const r = Math.max(0, -rank);
  return r / (1 + r);
}

export class SqliteStorage implements Storage, KvStore, VectorStore {
  readonly backend = 'sqlite';
  /** Absolute path of the database file, or ':memory:'. */
  readonly path: string;
  /** 'fts5' (bm25 ranking) or 'like' (substring fallback when this SQLite build lacks FTS5). */
  readonly searchMode: 'fts5' | 'like';
  /** Schema version (PRAGMA user_version) after migrations. */
  readonly schemaVersion: number;
  private db: DatabaseSync | null;

  constructor(opts: OpenOptions) {
    const opened = openDatabase(opts);
    this.db = opened.db;
    this.path = opened.path;
    this.searchMode = opened.fts ? 'fts5' : 'like';
    this.schemaVersion = opened.version;
    track(this);
  }

  /** Closes the connection. Safe to call twice; later calls on this instance throw. */
  close(): void {
    open.delete(this);
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    if (db.isOpen) db.close();
  }

  private get conn(): DatabaseSync {
    if (!this.db) {
      throw new Vid2ContextError('unavailable', 'The SQLite library connection is closed.', {
        hint: 'Open storage again with registry.openStorage(ctx).',
      });
    }
    return this.db;
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.conn.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.conn.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.conn.prepare(sql).run(...params);
  }

  // ------------------------------------------------------------ contexts

  async getContext(id: string): Promise<VideoContext | null> {
    const row = this.get('SELECT context FROM videos WHERE id = ?', id);
    return row ? (JSON.parse(row.context as string) as VideoContext) : null;
  }

  async putContext(context: VideoContext): Promise<void> {
    const s = summarize(context, new Date().toISOString());
    const json = JSON.stringify(context);
    transaction(this.conn, () => {
      this.run('DELETE FROM segments WHERE video_id = ?', s.id);
      this.run(
        `INSERT INTO videos (id, ref, title, channel, duration_sec, origin, language, saved_at, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET ref = excluded.ref, title = excluded.title, channel = excluded.channel,
           duration_sec = excluded.duration_sec, origin = excluded.origin, language = excluded.language,
           saved_at = excluded.saved_at, context = excluded.context`,
        s.id,
        JSON.stringify(s.ref),
        s.title,
        s.channel ?? null,
        s.durationSec ?? null,
        s.origin,
        s.language,
        s.savedAt,
        json,
      );
      const insert = this.conn.prepare(
        'INSERT INTO segments (video_id, idx, start_sec, end_sec, text, speaker) VALUES (?, ?, ?, ?, ?, ?)',
      );
      context.transcript.segments.forEach((seg, idx) => {
        insert.run(s.id, idx, seg.startSec, seg.endSec, seg.text, seg.speaker ?? null);
      });
    });
  }

  async deleteContext(id: string): Promise<void> {
    transaction(this.conn, () => {
      this.run('DELETE FROM segments WHERE video_id = ?', id);
      this.run('DELETE FROM videos WHERE id = ?', id);
      // Like MemoryStorage: the video leaves every collection, without touching updatedAt.
      this.run('DELETE FROM collection_items WHERE video_id = ?', id);
    });
  }

  async listContexts(opts: { limit?: number; cursor?: string } = {}): Promise<Page<VideoSummary>> {
    const limit = Math.max(1, Math.floor(opts.limit ?? 50));
    const cols = 'id, ref, title, channel, duration_sec, origin, language, saved_at';
    const rows = opts.cursor
      ? (() => {
          const [savedAt, id] = decodeCursor(opts.cursor);
          return this.all(
            `SELECT ${cols} FROM videos WHERE saved_at < ? OR (saved_at = ? AND id < ?)
             ORDER BY saved_at DESC, id DESC LIMIT ?`,
            savedAt,
            savedAt,
            id,
            limit + 1,
          );
        })()
      : this.all(`SELECT ${cols} FROM videos ORDER BY saved_at DESC, id DESC LIMIT ?`, limit + 1);
    const page = rows.slice(0, limit);
    const items: VideoSummary[] = page.map((r) => ({
      id: r.id as string,
      ref: JSON.parse(r.ref as string),
      title: r.title as string,
      ...(r.channel != null ? { channel: r.channel as string } : {}),
      ...(r.duration_sec != null ? { durationSec: r.duration_sec as number } : {}),
      origin: r.origin as VideoSummary['origin'],
      language: r.language as string,
      savedAt: r.saved_at as string,
    }));
    const last = page.at(-1);
    return rows.length > limit && last ? { items, cursor: encodeCursor(last.saved_at as string, last.id as string) } : { items };
  }

  // --------------------------------------------------------- collections

  private readCollection(id: string): Collection | null {
    const row = this.get('SELECT id, name, description, sources, created_at, updated_at FROM collections WHERE id = ?', id);
    if (!row) return null;
    const videoIds = this.all('SELECT video_id FROM collection_items WHERE collection_id = ? ORDER BY position', id).map(
      (r) => r.video_id as string,
    );
    return {
      id: row.id as string,
      name: row.name as string,
      ...(row.description != null ? { description: row.description as string } : {}),
      sources: JSON.parse(row.sources as string) as string[],
      videoIds,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private must(id: string): Collection {
    const c = this.readCollection(id);
    if (!c) throw notFound(id);
    return c;
  }

  async createCollection(input: { name: string; description?: string; sources?: string[] }): Promise<Collection> {
    const now = new Date().toISOString();
    const id = slugId(input.name);
    this.run(
      'INSERT INTO collections (id, name, description, sources, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      input.name,
      input.description ?? null,
      JSON.stringify(input.sources ?? []),
      now,
      now,
    );
    return this.must(id);
  }

  async getCollection(id: string): Promise<Collection | null> {
    return this.readCollection(id);
  }

  async listCollections(): Promise<Collection[]> {
    const ids = this.all('SELECT id FROM collections ORDER BY updated_at DESC, id').map((r) => r.id as string);
    return ids.map((id) => this.readCollection(id)).filter((c): c is Collection => c !== null);
  }

  async updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'sources'>>): Promise<Collection> {
    return transaction(this.conn, () => {
      const c = this.must(id);
      const name = typeof patch.name === 'string' ? patch.name : c.name;
      const description = 'description' in patch ? (patch.description ?? null) : (c.description ?? null);
      const sources = Array.isArray(patch.sources) ? patch.sources : c.sources;
      this.run(
        'UPDATE collections SET name = ?, description = ?, sources = ?, updated_at = ? WHERE id = ?',
        name,
        description,
        JSON.stringify(sources),
        new Date().toISOString(),
        id,
      );
      return this.must(id);
    });
  }

  async addToCollection(id: string, videoIds: string[]): Promise<Collection> {
    return transaction(this.conn, () => {
      this.must(id);
      const max = this.get('SELECT COALESCE(MAX(position), -1) AS p FROM collection_items WHERE collection_id = ?', id);
      let position = (max?.p as number) + 1;
      const insert = this.conn.prepare(
        'INSERT INTO collection_items (collection_id, video_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      );
      for (const v of videoIds) {
        if (insert.run(id, v, position).changes > 0) position++;
      }
      this.run('UPDATE collections SET updated_at = ? WHERE id = ?', new Date().toISOString(), id);
      return this.must(id);
    });
  }

  async removeFromCollection(id: string, videoIds: string[]): Promise<Collection> {
    return transaction(this.conn, () => {
      this.must(id);
      this.run(
        'DELETE FROM collection_items WHERE collection_id = ? AND video_id IN (SELECT value FROM json_each(?))',
        id,
        JSON.stringify(videoIds),
      );
      this.run('UPDATE collections SET updated_at = ? WHERE id = ?', new Date().toISOString(), id);
      return this.must(id);
    });
  }

  async deleteCollection(id: string): Promise<void> {
    // Idempotent, like MemoryStorage: deleting an unknown collection is not an error.
    this.run('DELETE FROM collections WHERE id = ?', id);
  }

  // -------------------------------------------------------------- search

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const terms = parseSearch(query.text ?? '');
    if (terms.length === 0) return [];
    const limit = Math.max(1, Math.floor(query.limit ?? 20));
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.collectionId !== undefined) {
      filters.push('s.video_id IN (SELECT video_id FROM collection_items WHERE collection_id = ?)');
      params.push(query.collectionId);
    }
    if (query.videoIds !== undefined) {
      filters.push('s.video_id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(query.videoIds));
    }
    return this.searchMode === 'fts5'
      ? this.searchFts(terms, filters, params, limit)
      : this.searchLike(terms, filters, params, limit);
  }

  private searchFts(terms: SearchTerm[], filters: string[], params: SQLInputValue[], limit: number): SearchHit[] {
    const match = toMatchExpression(terms);
    if (!match) return [];
    const where = ['segments_fts MATCH ?', ...filters].join(' AND ');
    const rows = this.all(
      `SELECT s.video_id, v.title, s.start_sec, s.end_sec, s.text, bm25(segments_fts) AS rank
       FROM segments_fts
       JOIN segments s ON s.seg_id = segments_fts.rowid
       JOIN videos v ON v.id = s.video_id
       WHERE ${where}
       ORDER BY rank, s.video_id, s.start_sec
       LIMIT ?`,
      match,
      ...params,
      limit,
    );
    return rows.map((r) => ({
      videoId: r.video_id as string,
      title: r.title as string,
      startSec: r.start_sec as number,
      endSec: r.end_sec as number,
      text: r.text as string,
      score: normalizeBm25(r.rank as number),
    }));
  }

  /** Fallback without FTS5: substring match, scored like MemoryStorage (fraction of terms found). */
  private searchLike(terms: SearchTerm[], filters: string[], params: SQLInputValue[], limit: number): SearchHit[] {
    const patterns = terms.map(likePattern);
    const any = patterns.map(() => "lower(s.text) LIKE ? ESCAPE '\\'").join(' OR ');
    const where = [`(${any})`, ...filters].join(' AND ');
    const rows = this.all(
      `SELECT s.video_id, v.title, s.start_sec, s.end_sec, s.text
       FROM segments s JOIN videos v ON v.id = s.video_id
       WHERE ${where}`,
      ...patterns,
      ...params,
    );
    const needles = terms.map((t) => t.text.toLowerCase());
    return rows
      .map((r) => {
        const text = (r.text as string).toLowerCase();
        const matched = needles.filter((n) => text.includes(n)).length;
        return {
          videoId: r.video_id as string,
          title: r.title as string,
          startSec: r.start_sec as number,
          endSec: r.end_sec as number,
          text: r.text as string,
          score: matched / needles.length,
        };
      })
      .sort((a, b) => b.score - a.score || a.videoId.localeCompare(b.videoId) || a.startSec - b.startSec)
      .slice(0, limit);
  }

  // ------------------------------------------------------------------ kv

  async kvGet<T = unknown>(key: string): Promise<T | null> {
    const row = this.get('SELECT value, expires_at FROM kv WHERE key = ?', key);
    if (!row) return null;
    if (row.expires_at != null && (row.expires_at as number) <= Date.now()) {
      this.run('DELETE FROM kv WHERE key = ? AND expires_at <= ?', key, Date.now());
      return null;
    }
    return JSON.parse(row.value as string) as T;
  }

  async kvSet(key: string, value: unknown, opts: { ttlSec?: number } = {}): Promise<void> {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new Vid2ContextError('bad-request', `Value for key "${key}" is not JSON-serialisable.`, {
        hint: 'Store plain objects, arrays, strings, numbers, booleans or null.',
      });
    }
    const now = Date.now();
    const expiresAt = opts.ttlSec && opts.ttlSec > 0 ? now + opts.ttlSec * 1000 : null;
    transaction(this.conn, () => {
      this.run(
        `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
        key,
        json,
        expiresAt,
      );
      // Lazy purge of expired rows, using the partial index on expires_at.
      this.run('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?', now);
    });
  }

  async kvDelete(key: string): Promise<void> {
    this.run('DELETE FROM kv WHERE key = ?', key);
  }

  async kvList(prefix: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ keys: string[]; cursor?: string }> {
    const limit = Math.max(1, Math.floor(opts.limit ?? 100));
    const after = opts.cursor ?? '';
    // key >= prefix lets the primary key index skip ahead; substr() keeps only true prefix matches.
    const rows = this.all(
      `SELECT key FROM kv
       WHERE key >= ? AND substr(key, 1, ?) = ? AND key > ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY key LIMIT ?`,
      prefix,
      prefix.length,
      prefix,
      after,
      Date.now(),
      limit + 1,
    );
    const keys = rows.slice(0, limit).map((r) => r.key as string);
    return rows.length > limit ? { keys, cursor: keys.at(-1) } : { keys };
  }

  // ------------------------------------------------------------- vectors

  async upsertVectors(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    transaction(this.conn, () => {
      const stmt = this.conn.prepare(
        `INSERT INTO vectors (id, model, video_id, start_sec, end_sec, text, vector) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (model, id) DO UPDATE SET video_id = excluded.video_id, start_sec = excluded.start_sec,
           end_sec = excluded.end_sec, text = excluded.text, vector = excluded.vector`,
      );
      for (const r of records) stmt.run(r.id, r.model, r.videoId, r.startSec, r.endSec, r.text, toBlob(r.vector));
    });
  }

  async deleteVectors(filter: { videoId: string; model?: string }): Promise<void> {
    if (filter.model === undefined) this.run('DELETE FROM vectors WHERE video_id = ?', filter.videoId);
    else this.run('DELETE FROM vectors WHERE video_id = ? AND model = ?', filter.videoId, filter.model);
  }

  /** Exact cosine search in JavaScript over the vectors of one model. */
  async queryVectors(query: VectorQuery): Promise<VectorHit[]> {
    const limit = Math.max(1, Math.floor(query.limit ?? 20));
    const rows = query.videoIds
      ? this.all(
          `SELECT id, video_id, start_sec, end_sec, text, vector FROM vectors
           WHERE model = ? AND video_id IN (SELECT value FROM json_each(?))`,
          query.model,
          JSON.stringify(query.videoIds),
        )
      : this.all('SELECT id, video_id, start_sec, end_sec, text, vector FROM vectors WHERE model = ?', query.model);
    const q = query.vector;
    const qn = norm(q);
    const hits: VectorHit[] = rows.map((r) => {
      const v = fromBlob(r.vector as Uint8Array);
      const n = Math.min(q.length, v.length);
      let dot = 0;
      for (let i = 0; i < n; i++) dot += (q[i] as number) * (v[i] as number);
      const vn = norm(v);
      return {
        id: r.id as string,
        videoId: r.video_id as string,
        startSec: r.start_sec as number,
        endSec: r.end_sec as number,
        text: r.text as string,
        score: qn === 0 || vn === 0 ? 0 : dot / (qn * vn),
      };
    });
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
