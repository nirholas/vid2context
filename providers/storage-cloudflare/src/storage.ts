/**
 * Storage on Cloudflare D1, with R2 for large contexts and uploaded media and
 * Workers KV (or a D1 table) for small JSON state.
 *
 * Limits that shape the design (developers.cloudflare.com/d1/platform/limits, checked 2026-11-14):
 * a D1 row, string or BLOB is at most 2,000,000 bytes and a query takes at most
 * 100 bound parameters. Contexts larger than R2_THRESHOLD_BYTES go to R2 when a
 * bucket is bound; segment rows are inserted in chunks that stay under 100 parameters.
 */
import {
  type Collection,
  type KvStore,
  type Page,
  type SearchHit,
  type SearchQuery,
  type Storage,
  summarize,
  Vid2ContextError,
  type VideoContext,
  type VideoSummary,
} from '@vid2context/core';
import type { D1Database, D1PreparedStatement, KVNamespace, R2Bucket } from './bindings.ts';
import { LATEST_VERSION, MIGRATIONS } from './migrations.ts';

/** Contexts above this many bytes of JSON are stored in R2 (when bound); the D1 row keeps the key. */
export const R2_THRESHOLD_BYTES = 1_000_000;
/** D1's row limit is 2,000,000 bytes; leave room for the other columns. */
export const D1_MAX_CONTEXT_BYTES = 1_900_000;
/** Workers KV rejects expirationTtl below 60 seconds, so shorter TTLs are raised to 60. */
export const KV_MIN_TTL_SEC = 60;

const SEGMENT_COLS = 6;
const ROWS_PER_INSERT = Math.floor(100 / SEGMENT_COLS);

export interface CloudflareStorageOptions {
  db: D1Database;
  r2?: R2Bucket;
  kv?: KVNamespace;
  /** Contexts larger than this many bytes of JSON go to R2 when a bucket is bound. Default R2_THRESHOLD_BYTES. */
  r2ThresholdBytes?: number;
}

const migrated = new WeakSet<object>();

/** Apply missing migrations once per D1 binding object (a Worker isolate reuses it across requests). */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (migrated.has(db)) return;
  let version = 0;
  try {
    const row = await db.prepare('SELECT MAX(version) AS v FROM schema_version').first<{ v: number | null }>();
    version = row?.v ?? 0;
  } catch {
    version = 0;
  }
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    await db.batch(m.statements.map((s) => db.prepare(s)));
  }
  if (version < LATEST_VERSION) {
    const row = await db.prepare('SELECT MAX(version) AS v FROM schema_version').first<{ v: number | null }>();
    if ((row?.v ?? 0) < LATEST_VERSION) {
      throw new Vid2ContextError('unavailable', 'The D1 schema could not be brought up to date.', {
        hint: 'Run `wrangler d1 migrations apply <database>` with migrations_dir providers/storage-cloudflare/migrations.',
      });
    }
  }
  migrated.add(db);
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

function encodeCursor(savedAt: string, id: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(JSON.stringify([savedAt, id]))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const bin = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw new Vid2ContextError('bad-request', 'Invalid list cursor.', {
    hint: 'Pass the cursor exactly as the previous page returned it.',
  });
}

/**
 * Turn free text into a safe FTS5 query: words only (letters and digits), each
 * quoted so FTS5 operators and syntax in the input are never interpreted,
 * joined with OR so any word matches and bm25 ranks segments matching more words higher.
 */
export function ftsQuery(text: string): string | null {
  const words = text.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(words.map((w) => w.toLowerCase()))].slice(0, 32);
  if (unique.length === 0) return null;
  return unique.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ');
}

function r2KeyFor(id: string): string {
  return `contexts/${encodeURIComponent(id)}.json`;
}

interface VideoRow {
  id: string;
  ref: string;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  origin: VideoContext['transcript']['origin'];
  language: string;
  saved_at: string;
}

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  sources: string;
  created_at: string;
  updated_at: string;
}

function toSummary(r: VideoRow): VideoSummary {
  const s: VideoSummary = {
    id: r.id,
    ref: JSON.parse(r.ref) as VideoSummary['ref'],
    title: r.title,
    origin: r.origin,
    language: r.language,
    savedAt: r.saved_at,
  };
  if (r.channel !== null) s.channel = r.channel;
  if (r.duration_sec !== null) s.durationSec = r.duration_sec;
  return s;
}

function toCollection(r: CollectionRow, videoIds: string[]): Collection {
  const c: Collection = {
    id: r.id,
    name: r.name,
    sources: JSON.parse(r.sources) as string[],
    videoIds,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.description !== null) c.description = r.description;
  return c;
}

const encoder = new TextEncoder();

export class CloudflareStorage implements Storage, KvStore {
  readonly backend: string = 'cloudflare-d1';
  protected readonly db: D1Database;
  protected readonly r2?: R2Bucket;
  protected readonly kv?: KVNamespace;
  private readonly r2Threshold: number;

  constructor(opts: CloudflareStorageOptions) {
    this.db = opts.db;
    this.r2 = opts.r2;
    this.kv = opts.kv;
    this.r2Threshold = opts.r2ThresholdBytes ?? R2_THRESHOLD_BYTES;
  }

  // ------------------------------------------------------------ contexts

  async getContext(id: string): Promise<VideoContext | null> {
    const row = await this.db
      .prepare('SELECT context, r2_key FROM videos WHERE id = ?')
      .bind(id)
      .first<{ context: string | null; r2_key: string | null }>();
    if (!row) return null;
    if (row.context !== null) return JSON.parse(row.context) as VideoContext;
    if (row.r2_key && this.r2) {
      const obj = await this.r2.get(row.r2_key);
      if (obj) return JSON.parse(await obj.text()) as VideoContext;
    }
    throw new Vid2ContextError('unavailable', `The saved context for ${id} is stored in R2 and could not be read.`, {
      hint: 'Bind the R2 bucket it was saved with (VID2CONTEXT_R2), or save the video again.',
    });
  }

  async putContext(context: VideoContext): Promise<void> {
    const id = context.metadata.ref.id;
    const json = JSON.stringify(context);
    const bytes = encoder.encode(json).byteLength;
    const previous = await this.db.prepare('SELECT r2_key FROM videos WHERE id = ?').bind(id).first<{ r2_key: string | null }>();

    let inline: string | null = json;
    let r2Key: string | null = null;
    if (bytes > this.r2Threshold && this.r2) {
      r2Key = r2KeyFor(id);
      await this.r2.put(r2Key, json, { httpMetadata: { contentType: 'application/json' } });
      inline = null;
    } else if (bytes > D1_MAX_CONTEXT_BYTES) {
      throw new Vid2ContextError('too-large', `This context is ${bytes} bytes; a D1 row holds at most 2,000,000.`, {
        hint: 'Bind an R2 bucket and set VID2CONTEXT_R2 so large contexts are stored there.',
      });
    }

    const s = summarize(context, new Date().toISOString());
    const stmts: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO videos (id, ref, title, channel, duration_sec, origin, language, saved_at, context, r2_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET ref = excluded.ref, title = excluded.title, channel = excluded.channel,
             duration_sec = excluded.duration_sec, origin = excluded.origin, language = excluded.language,
             saved_at = excluded.saved_at, context = excluded.context, r2_key = excluded.r2_key`,
        )
        .bind(
          id,
          JSON.stringify(s.ref),
          s.title,
          s.channel ?? null,
          s.durationSec ?? null,
          s.origin,
          s.language,
          s.savedAt,
          inline,
          r2Key,
        ),
      this.db.prepare('DELETE FROM segments WHERE video_id = ?').bind(id),
    ];
    const segs = context.transcript.segments;
    for (let i = 0; i < segs.length; i += ROWS_PER_INSERT) {
      const chunk = segs.slice(i, i + ROWS_PER_INSERT);
      const values: unknown[] = [];
      chunk.forEach((seg, j) => {
        values.push(id, i + j, seg.startSec, seg.endSec, seg.text, seg.speaker ?? null);
      });
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO segments (video_id, idx, start_sec, end_sec, text, speaker) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
          )
          .bind(...values),
      );
    }
    await this.db.batch(stmts);
    if (previous?.r2_key && previous.r2_key !== r2Key && this.r2) await this.r2.delete(previous.r2_key);
  }

  async deleteContext(id: string): Promise<void> {
    const row = await this.db.prepare('SELECT r2_key FROM videos WHERE id = ?').bind(id).first<{ r2_key: string | null }>();
    if (!row) return;
    await this.db.batch([
      this.db.prepare('DELETE FROM segments WHERE video_id = ?').bind(id),
      this.db.prepare('DELETE FROM collection_items WHERE video_id = ?').bind(id),
      this.db.prepare('DELETE FROM videos WHERE id = ?').bind(id),
    ]);
    if (row.r2_key && this.r2) await this.r2.delete(row.r2_key);
  }

  async listContexts(opts: { limit?: number; cursor?: string } = {}): Promise<Page<VideoSummary>> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const cols = 'id, ref, title, channel, duration_sec, origin, language, saved_at';
    const stmt = opts.cursor
      ? (() => {
          const [savedAt, id] = decodeCursor(opts.cursor);
          return this.db
            .prepare(
              `SELECT ${cols} FROM videos WHERE saved_at < ? OR (saved_at = ? AND id < ?) ORDER BY saved_at DESC, id DESC LIMIT ?`,
            )
            .bind(savedAt, savedAt, id, limit + 1);
        })()
      : this.db.prepare(`SELECT ${cols} FROM videos ORDER BY saved_at DESC, id DESC LIMIT ?`).bind(limit + 1);
    const { results } = await stmt.all<VideoRow>();
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toSummary),
      cursor: results.length > limit && last ? encodeCursor(last.saved_at, last.id) : undefined,
    };
  }

  // ------------------------------------------------------------ collections

  async createCollection(input: { name: string; description?: string; sources?: string[] }): Promise<Collection> {
    const now = new Date().toISOString();
    const id = slugId(input.name);
    await this.db
      .prepare('INSERT INTO collections (id, name, description, sources, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, input.name, input.description ?? null, JSON.stringify(input.sources ?? []), now, now)
      .run();
    return this.must(id);
  }

  async getCollection(id: string): Promise<Collection | null> {
    const [row, items] = await this.db.batch([
      this.db.prepare('SELECT * FROM collections WHERE id = ?').bind(id),
      this.db.prepare('SELECT video_id FROM collection_items WHERE collection_id = ? ORDER BY position').bind(id),
    ]);
    const r = row?.results[0] as CollectionRow | undefined;
    if (!r) return null;
    return toCollection(
      r,
      (items?.results ?? []).map((x) => (x as { video_id: string }).video_id),
    );
  }

  async listCollections(): Promise<Collection[]> {
    const [rows, items] = await this.db.batch([
      this.db.prepare('SELECT * FROM collections ORDER BY updated_at DESC, id'),
      this.db.prepare('SELECT collection_id, video_id FROM collection_items ORDER BY collection_id, position'),
    ]);
    const byCollection = new Map<string, string[]>();
    for (const x of (items?.results ?? []) as { collection_id: string; video_id: string }[]) {
      const list = byCollection.get(x.collection_id) ?? [];
      list.push(x.video_id);
      byCollection.set(x.collection_id, list);
    }
    return ((rows?.results ?? []) as unknown as CollectionRow[]).map((r) => toCollection(r, byCollection.get(r.id) ?? []));
  }

  private async must(id: string): Promise<Collection> {
    const c = await this.getCollection(id);
    if (!c) {
      throw new Vid2ContextError('not-found', `Collection not found: ${id}`, { hint: 'List collections to see valid ids.' });
    }
    return c;
  }

  async updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'sources'>>): Promise<Collection> {
    const c = await this.must(id);
    const next = { ...c, ...patch };
    await this.db
      .prepare('UPDATE collections SET name = ?, description = ?, sources = ?, updated_at = ? WHERE id = ?')
      .bind(next.name, next.description ?? null, JSON.stringify(next.sources ?? []), new Date().toISOString(), id)
      .run();
    return this.must(id);
  }

  async addToCollection(id: string, videoIds: string[]): Promise<Collection> {
    await this.must(id);
    const stmts = [...new Set(videoIds)].map((v) =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO collection_items (collection_id, video_id, position)
           VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM collection_items WHERE collection_id = ?))`,
        )
        .bind(id, v, id),
    );
    stmts.push(this.db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), id));
    await this.db.batch(stmts);
    return this.must(id);
  }

  async removeFromCollection(id: string, videoIds: string[]): Promise<Collection> {
    await this.must(id);
    await this.db.batch([
      this.db
        .prepare('DELETE FROM collection_items WHERE collection_id = ? AND video_id IN (SELECT value FROM json_each(?))')
        .bind(id, JSON.stringify(videoIds)),
      this.db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), id),
    ]);
    return this.must(id);
  }

  async deleteCollection(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM collection_items WHERE collection_id = ?').bind(id),
      this.db.prepare('DELETE FROM collections WHERE id = ?').bind(id),
    ]);
  }

  // ------------------------------------------------------------ search

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const match = ftsQuery(query.text);
    if (!match) return [];
    const where = ['segments_fts MATCH ?'];
    const params: unknown[] = [match];
    if (query.collectionId) {
      where.push('s.video_id IN (SELECT video_id FROM collection_items WHERE collection_id = ?)');
      params.push(query.collectionId);
    }
    if (query.videoIds) {
      where.push('s.video_id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(query.videoIds));
    }
    params.push(Math.max(1, Math.min(query.limit ?? 20, 200)));
    const { results } = await this.db
      .prepare(
        `SELECT s.video_id AS video_id, v.title AS title, s.start_sec AS start_sec, s.end_sec AS end_sec, s.text AS text,
                bm25(segments_fts) AS rank
         FROM segments_fts
         JOIN segments s ON s.rowid = segments_fts.rowid
         JOIN videos v ON v.id = s.video_id
         WHERE ${where.join(' AND ')}
         ORDER BY rank, s.video_id, s.idx
         LIMIT ?`,
      )
      .bind(...params)
      .all<{ video_id: string; title: string; start_sec: number; end_sec: number; text: string; rank: number }>();
    // bm25() is lower-is-better and negative for matches; flip it so a higher score is better, as SearchHit expects.
    return results.map((r) => ({
      videoId: r.video_id,
      title: r.title,
      startSec: r.start_sec,
      endSec: r.end_sec,
      text: r.text,
      score: -r.rank,
    }));
  }

  // ------------------------------------------------------------ KvStore (Workers KV when bound, else a D1 table)

  async kvGet<T = unknown>(key: string): Promise<T | null> {
    if (this.kv) {
      const raw = await this.kv.get(key, 'text');
      return raw === null ? null : (JSON.parse(raw) as T);
    }
    const row = await this.db
      .prepare('SELECT value, expires_at FROM kv WHERE key = ?')
      .bind(key)
      .first<{ value: string; expires_at: number | null }>();
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      await this.db.prepare('DELETE FROM kv WHERE key = ? AND expires_at <= ?').bind(key, Date.now()).run();
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  async kvSet(key: string, value: unknown, opts: { ttlSec?: number } = {}): Promise<void> {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Vid2ContextError('bad-request', 'kvSet needs a JSON-serialisable value.');
    const ttl = opts.ttlSec && opts.ttlSec > 0 ? opts.ttlSec : undefined;
    if (this.kv) {
      await this.kv.put(key, json, ttl ? { expirationTtl: Math.max(KV_MIN_TTL_SEC, Math.ceil(ttl)) } : undefined);
      return;
    }
    await this.db
      .prepare(
        'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      )
      .bind(key, json, ttl ? Date.now() + ttl * 1000 : null)
      .run();
  }

  async kvDelete(key: string): Promise<void> {
    if (this.kv) {
      await this.kv.delete(key);
      return;
    }
    await this.db.prepare('DELETE FROM kv WHERE key = ?').bind(key).run();
  }

  async kvList(prefix: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ keys: string[]; cursor?: string }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    if (this.kv) {
      const res = await this.kv.list({ prefix, limit, cursor: opts.cursor });
      const keys = res.keys.map((k) => k.name);
      return res.list_complete || !res.cursor ? { keys } : { keys, cursor: res.cursor };
    }
    const { results } = await this.db
      .prepare(
        `SELECT key FROM kv WHERE substr(key, 1, ?) = ? AND key > ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY key LIMIT ?`,
      )
      .bind(prefix.length, prefix, opts.cursor ?? '', Date.now(), limit + 1)
      .all<{ key: string }>();
    const keys = results.slice(0, limit).map((r) => r.key);
    return results.length > limit ? { keys, cursor: keys.at(-1) } : { keys };
  }

  // ------------------------------------------------------------ R2 blobs (uploaded media)

  /** Store bytes in R2 under `blobs/<key>`. Throws when no bucket is bound. */
  async putBlob(key: string, data: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    await this.bucket().put(`blobs/${key}`, data, { httpMetadata: { contentType } });
  }

  async getBlob(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
    const obj = await this.bucket().get(`blobs/${key}`);
    if (!obj) return null;
    return {
      data: new Uint8Array(await obj.arrayBuffer()),
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }

  async deleteBlob(key: string): Promise<void> {
    await this.bucket().delete(`blobs/${key}`);
  }

  private bucket(): R2Bucket {
    if (!this.r2) {
      throw new Vid2ContextError('no-provider', 'No R2 bucket is bound for uploaded media.', {
        hint: 'Add an r2_buckets entry to wrangler.jsonc and set VID2CONTEXT_R2 to its binding name.',
      });
    }
    return this.r2;
  }
}
