/**
 * Storage, KvStore and VectorStore on Postgres. One instance is bound to one
 * tenant and every statement filters by it; `forTenant` returns a sibling
 * instance on the same connection for multi-user servers.
 *
 * SQL conventions: identifiers are the quoted schema plus fixed table names;
 * values always travel as $n parameters, except the embedding model name and
 * dimension count in vector queries, which are inlined as a quoted literal and
 * a validated integer because the planner can only match a partial HNSW index
 * whose predicate it can prove from constants.
 */
import {
  type Collection,
  type KvStore,
  type Page,
  type SearchHit,
  type SearchQuery,
  type Storage,
  type VectorHit,
  type VectorQuery,
  type VectorRecord,
  type VectorStore,
  type VideoContext,
  type VideoSummary,
  Vid2ContextError,
} from '@vid2context/core';
import type { Db, Param, Row, Statement } from './db.ts';
import { toStorageError } from './errors.ts';
import { quoteIdent, quoteLiteral } from './migrate.ts';

/** A search hit with a highlighted copy of the segment (matches wrapped in **). `text` stays the raw segment. */
export interface PgSearchHit extends SearchHit {
  snippet: string;
}

/** Connection-wide state shared by every tenant's instance. */
export interface Shared {
  db: Db;
  schema: string;
  secrets: string[];
  /** model -> dimensions and index, learned from vector_models. */
  vectorModels: Map<string, { dimensions: number; index: 'vector' | 'halfvec' | null }>;
  /** pgvector version, read once. */
  pgvector?: Promise<string>;
  /** Releases this handle's share of the connection. */
  release(): Promise<void>;
}

/**
 * Postgres text search configurations by BCP-47 primary language subtag. A
 * configuration the server does not have falls back to 'simple' in SQL.
 * Languages without one (Chinese, Japanese, Korean, ...) use 'simple', which
 * splits on spaces and punctuation only.
 */
export const TS_CONFIGS: Record<string, string> = {
  ar: 'arabic',
  hy: 'armenian',
  eu: 'basque',
  ca: 'catalan',
  da: 'danish',
  nl: 'dutch',
  en: 'english',
  fi: 'finnish',
  fr: 'french',
  de: 'german',
  el: 'greek',
  hi: 'hindi',
  hu: 'hungarian',
  id: 'indonesian',
  ga: 'irish',
  it: 'italian',
  lt: 'lithuanian',
  ne: 'nepali',
  no: 'norwegian',
  nb: 'norwegian',
  nn: 'norwegian',
  pt: 'portuguese',
  ro: 'romanian',
  ru: 'russian',
  sr: 'serbian',
  es: 'spanish',
  sv: 'swedish',
  ta: 'tamil',
  tr: 'turkish',
  yi: 'yiddish',
};

export function tsConfigFor(language: string | undefined): string {
  const primary = (language ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return TS_CONFIGS[primary] ?? 'simple';
}

/** pgvector's HNSW limits: 2000 dimensions for vector, 4000 for halfvec. Above that, queries scan exactly. */
export function indexTypeFor(dimensions: number): 'vector' | 'halfvec' | null {
  if (dimensions <= 2000) return 'vector';
  if (dimensions <= 4000) return 'halfvec';
  return null;
}

function iso(col: string): string {
  return `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
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

function encodeCursor(parts: string[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string, size: number): string[] {
  try {
    const bin = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const parts = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as unknown;
    if (Array.isArray(parts) && parts.length === size && parts.every((p) => typeof p === 'string')) return parts;
  } catch {
    // Fall through to the error below.
  }
  throw new Vid2ContextError('bad-request', 'Invalid list cursor.', { hint: 'Pass the cursor exactly as a previous page returned it, or omit it.' });
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

function notFoundCollection(id: string): Vid2ContextError {
  return new Vid2ContextError('not-found', `Collection not found: ${id}`, { hint: 'List collections to see valid ids.' });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function vectorLiteral(v: number[]): string {
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new Vid2ContextError('bad-request', 'Vectors must contain only finite numbers.', { hint: 'Check the embedding response.' });
    }
  }
  return `[${v.join(',')}]`;
}

interface CollectionRow extends Row {
  id: string;
  name: string;
  description: string | null;
  sources: string;
  video_ids: string;
  created_at: string;
  updated_at: string;
}

export class PostgresStorage implements Storage, KvStore, VectorStore {
  readonly backend = 'postgres';
  readonly tenant: string;
  private readonly s: Shared;
  private readonly S: string;

  constructor(shared: Shared, tenant: string) {
    this.s = shared;
    this.tenant = tenant;
    this.S = quoteIdent(shared.schema);
  }

  /** The same database and schema, scoped to another tenant. */
  forTenant(tenant: string): PostgresStorage {
    return new PostgresStorage(this.s, tenant);
  }

  /** Releases this instance's share of the connection pool. */
  async close(): Promise<void> {
    await this.s.release();
  }

  private async q<T extends Row = Row>(text: string, params: Param[] = []): Promise<T[]> {
    try {
      return await this.s.db.query<T>(text, params);
    } catch (err) {
      throw toStorageError(err, this.s.secrets);
    }
  }

  private async tx(statements: Statement[]): Promise<Row[][]> {
    try {
      return await this.s.db.batch(statements);
    } catch (err) {
      throw toStorageError(err, this.s.secrets);
    }
  }

  // ------------------------------------------------------------- contexts

  async getContext(id: string): Promise<VideoContext | null> {
    const rows = await this.q<{ context: string }>(`SELECT context::text AS context FROM ${this.S}.videos WHERE tenant_id = $1 AND id = $2`, [
      this.tenant,
      id,
    ]);
    const raw = rows[0]?.context;
    return raw === undefined ? null : (JSON.parse(raw) as VideoContext);
  }

  async putContext(context: VideoContext): Promise<void> {
    const S = this.S;
    const m = context.metadata;
    const t = context.transcript;
    const cfg = { text: `(SELECT coalesce(max(cfgname::text), 'simple') FROM pg_ts_config WHERE cfgname = $3)::regconfig` };
    const segments = t.segments.map((seg, idx) => ({
      idx,
      start_sec: seg.startSec,
      end_sec: seg.endSec,
      text: seg.text,
      speaker: seg.speaker ?? null,
    }));
    await this.tx([
      {
        text: `INSERT INTO ${S}.videos (tenant_id, id, ref, title, channel, duration_sec, origin, language, ts_config, saved_at, context)
          VALUES ($1, $2, $4::jsonb, $5, $6, $7, $8, $9, ${cfg.text}, now(), $10::jsonb)
          ON CONFLICT (tenant_id, id) DO UPDATE SET ref = excluded.ref, title = excluded.title, channel = excluded.channel,
            duration_sec = excluded.duration_sec, origin = excluded.origin, language = excluded.language,
            ts_config = excluded.ts_config, saved_at = excluded.saved_at, context = excluded.context`,
        params: [
          this.tenant,
          m.ref.id,
          tsConfigFor(t.language),
          JSON.stringify(m.ref),
          m.title,
          m.channel?.name ?? null,
          m.durationSec ?? null,
          t.origin,
          t.language,
          JSON.stringify(context),
        ],
      },
      { text: `DELETE FROM ${S}.segments WHERE tenant_id = $1 AND video_id = $2`, params: [this.tenant, m.ref.id] },
      {
        text: `INSERT INTO ${S}.segments (tenant_id, video_id, idx, start_sec, end_sec, text, speaker, ts_config)
          SELECT $1, $2, r.idx, r.start_sec, r.end_sec, r.text, r.speaker, ${cfg.text}
          FROM jsonb_to_recordset($4::jsonb) AS r(idx integer, start_sec double precision, end_sec double precision, text text, speaker text)`,
        params: [this.tenant, m.ref.id, tsConfigFor(t.language), JSON.stringify(segments)],
      },
    ]);
  }

  async deleteContext(id: string): Promise<void> {
    const S = this.S;
    const p = [this.tenant, id];
    await this.tx([
      { text: `DELETE FROM ${S}.collection_items WHERE tenant_id = $1 AND video_id = $2`, params: p },
      { text: `DELETE FROM ${S}.vectors WHERE tenant_id = $1 AND video_id = $2`, params: p },
      // Segments go with the video through ON DELETE CASCADE.
      { text: `DELETE FROM ${S}.videos WHERE tenant_id = $1 AND id = $2`, params: p },
    ]);
  }

  async listContexts(opts: { limit?: number; cursor?: string } = {}): Promise<Page<VideoSummary>> {
    const limit = clampLimit(opts.limit, 50, 1000);
    const [afterSavedAt, afterId] = opts.cursor ? decodeCursor(opts.cursor, 2) : [null, null];
    const rows = await this.q<{
      id: string;
      ref: string;
      title: string;
      channel: string | null;
      duration_sec: number | null;
      origin: VideoSummary['origin'];
      language: string;
      saved_at: string;
      saved_at_raw: string;
    }>(
      `SELECT id, ref::text AS ref, title, channel, duration_sec, origin, language, ${iso('saved_at')} AS saved_at, saved_at::text AS saved_at_raw
       FROM ${this.S}.videos
       WHERE tenant_id = $1 AND ($2::timestamptz IS NULL OR (saved_at, id) < ($2::timestamptz, $3::text))
       ORDER BY saved_at DESC, id DESC
       LIMIT $4`,
      [this.tenant, afterSavedAt ?? null, afterId ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const items: VideoSummary[] = page.map((r) => ({
      id: r.id,
      ref: JSON.parse(r.ref),
      title: r.title,
      channel: r.channel ?? undefined,
      durationSec: r.duration_sec ?? undefined,
      origin: r.origin,
      language: r.language,
      savedAt: r.saved_at,
    }));
    const last = page.at(-1);
    return rows.length > limit && last ? { items, cursor: encodeCursor([last.saved_at_raw, last.id]) } : { items };
  }

  // ---------------------------------------------------------- collections

  private collectionSelect(where: string): string {
    const S = this.S;
    return `SELECT c.id, c.name, c.description, c.sources::text AS sources,
        ${iso('c.created_at')} AS created_at, ${iso('c.updated_at')} AS updated_at,
        coalesce((SELECT json_agg(ci.video_id ORDER BY ci.position, ci.video_id) FROM ${S}.collection_items ci
                  WHERE ci.tenant_id = c.tenant_id AND ci.collection_id = c.id)::text, '[]') AS video_ids
      FROM ${S}.collections c WHERE c.tenant_id = $1 ${where}`;
  }

  private toCollection(r: Row): Collection {
    const row = r as CollectionRow;
    const c: Collection = {
      id: row.id,
      name: row.name,
      sources: JSON.parse(row.sources),
      videoIds: JSON.parse(row.video_ids),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.description !== null) c.description = row.description;
    return c;
  }

  async createCollection(input: { name: string; description?: string; sources?: string[] }): Promise<Collection> {
    const id = slugId(input.name);
    const [, rows] = await this.tx([
      {
        text: `INSERT INTO ${this.S}.collections (tenant_id, id, name, description, sources) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        params: [this.tenant, id, input.name, input.description ?? null, JSON.stringify(input.sources ?? [])],
      },
      { text: this.collectionSelect('AND c.id = $2'), params: [this.tenant, id] },
    ]);
    const row = rows?.[0];
    if (!row) throw notFoundCollection(id);
    return this.toCollection(row);
  }

  async getCollection(id: string): Promise<Collection | null> {
    const rows = await this.q(this.collectionSelect('AND c.id = $2'), [this.tenant, id]);
    return rows[0] ? this.toCollection(rows[0]) : null;
  }

  async listCollections(): Promise<Collection[]> {
    const rows = await this.q(`${this.collectionSelect('')} ORDER BY c.updated_at DESC, c.id`, [this.tenant]);
    return rows.map((r) => this.toCollection(r));
  }

  async updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'description' | 'sources'>>): Promise<Collection> {
    const hasName = patch.name !== undefined;
    const hasDescription = 'description' in patch;
    const hasSources = patch.sources !== undefined;
    const [, rows] = await this.tx([
      {
        text: `UPDATE ${this.S}.collections SET
            name = CASE WHEN $3::boolean THEN $4::text ELSE name END,
            description = CASE WHEN $5::boolean THEN $6::text ELSE description END,
            sources = CASE WHEN $7::boolean THEN $8::jsonb ELSE sources END,
            updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        params: [
          this.tenant,
          id,
          hasName,
          patch.name ?? null,
          hasDescription,
          patch.description ?? null,
          hasSources,
          JSON.stringify(patch.sources ?? []),
        ],
      },
      { text: this.collectionSelect('AND c.id = $2'), params: [this.tenant, id] },
    ]);
    const row = rows?.[0];
    if (!row) throw notFoundCollection(id);
    return this.toCollection(row);
  }

  async addToCollection(id: string, videoIds: string[]): Promise<Collection> {
    const S = this.S;
    const [, , rows] = await this.tx([
      {
        text: `INSERT INTO ${S}.collection_items (tenant_id, collection_id, video_id, position)
          SELECT $1, c.id, n.video_id,
            (coalesce((SELECT max(position) FROM ${S}.collection_items WHERE tenant_id = $1 AND collection_id = $2), -1) + n.ord)::integer
          FROM ${S}.collections c,
            (SELECT value AS video_id, min(ordinality) AS ord FROM jsonb_array_elements_text($3::jsonb) WITH ORDINALITY GROUP BY value) n
          WHERE c.tenant_id = $1 AND c.id = $2
          ON CONFLICT (tenant_id, collection_id, video_id) DO NOTHING`,
        params: [this.tenant, id, JSON.stringify(videoIds)],
      },
      { text: `UPDATE ${S}.collections SET updated_at = now() WHERE tenant_id = $1 AND id = $2`, params: [this.tenant, id] },
      { text: this.collectionSelect('AND c.id = $2'), params: [this.tenant, id] },
    ]);
    const row = rows?.[0];
    if (!row) throw notFoundCollection(id);
    return this.toCollection(row);
  }

  async removeFromCollection(id: string, videoIds: string[]): Promise<Collection> {
    const S = this.S;
    const [, , rows] = await this.tx([
      {
        text: `DELETE FROM ${S}.collection_items WHERE tenant_id = $1 AND collection_id = $2
          AND video_id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
        params: [this.tenant, id, JSON.stringify(videoIds)],
      },
      { text: `UPDATE ${S}.collections SET updated_at = now() WHERE tenant_id = $1 AND id = $2`, params: [this.tenant, id] },
      { text: this.collectionSelect('AND c.id = $2'), params: [this.tenant, id] },
    ]);
    const row = rows?.[0];
    if (!row) throw notFoundCollection(id);
    return this.toCollection(row);
  }

  async deleteCollection(id: string): Promise<void> {
    // Items go with it through ON DELETE CASCADE.
    await this.q(`DELETE FROM ${this.S}.collections WHERE tenant_id = $1 AND id = $2`, [this.tenant, id]);
  }

  // --------------------------------------------------------------- search

  /**
   * Full-text search. Each video's segments are indexed with the text search
   * configuration of its transcript language, so the query is parsed once
   * per configuration in use (websearch_to_tsquery accepts any input:
   * "quoted phrases", OR, -exclusions) and matched against segments of that
   * configuration only. Scores are ts_rank_cd normalised to 0..1.
   */
  async search(query: SearchQuery): Promise<PgSearchHit[]> {
    const text = query.text.trim();
    if (!text) return [];
    const S = this.S;
    const params: Param[] = [this.tenant, text, clampLimit(query.limit, 20, 1000)];
    let filter = '';
    if (query.collectionId !== undefined) {
      params.push(query.collectionId);
      filter += ` AND s.video_id IN (SELECT ci.video_id FROM ${S}.collection_items ci WHERE ci.tenant_id = $1 AND ci.collection_id = $${params.length})`;
    }
    if (query.videoIds !== undefined) {
      params.push(JSON.stringify(query.videoIds));
      filter += ` AND s.video_id IN (SELECT jsonb_array_elements_text($${params.length}::jsonb))`;
    }
    const rows = await this.q<{
      video_id: string;
      title: string;
      start_sec: number;
      end_sec: number;
      text: string;
      score: number;
      snippet: string;
    }>(
      `WITH q AS (
         SELECT v.cfg, websearch_to_tsquery(v.cfg, $2) AS query
         FROM (SELECT DISTINCT ts_config AS cfg FROM ${S}.videos WHERE tenant_id = $1) v
       ), hits AS (
         SELECT s.video_id, s.start_sec, s.end_sec, s.text, s.ts_config, q.query, ts_rank_cd(s.tsv, q.query, 32) AS score
         FROM q JOIN ${S}.segments s ON s.ts_config = q.cfg AND s.tsv @@ q.query
         WHERE s.tenant_id = $1${filter}
         ORDER BY score DESC, s.start_sec, s.video_id
         LIMIT $3
       )
       SELECT h.video_id, v.title, h.start_sec, h.end_sec, h.text, h.score,
         ts_headline(h.ts_config, h.text, h.query, 'StartSel=**, StopSel=**, HighlightAll=true') AS snippet
       FROM hits h JOIN ${S}.videos v ON v.tenant_id = $1 AND v.id = h.video_id
       ORDER BY h.score DESC, h.start_sec, h.video_id`,
      params,
    );
    return rows.map((r) => ({
      videoId: r.video_id,
      title: r.title,
      startSec: Number(r.start_sec),
      endSec: Number(r.end_sec),
      text: r.text,
      score: Number(r.score),
      snippet: r.snippet,
    }));
  }

  // ------------------------------------------------------------------- kv

  async kvGet<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.q<{ value: string; expired: boolean }>(
      `SELECT value::text AS value, (expires_at IS NOT NULL AND expires_at <= now()) AS expired FROM ${this.S}.kv WHERE tenant_id = $1 AND key = $2`,
      [this.tenant, key],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.expired) {
      await this.q(`DELETE FROM ${this.S}.kv WHERE tenant_id = $1 AND key = $2 AND expires_at <= now()`, [this.tenant, key]);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  async kvSet(key: string, value: unknown, opts: { ttlSec?: number } = {}): Promise<void> {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new Vid2ContextError('bad-request', `kvSet(${JSON.stringify(key)}): the value is not JSON-serialisable.`, {
        hint: 'Store null, a number, a string, an array or a plain object.',
      });
    }
    const ttl = opts.ttlSec && opts.ttlSec > 0 ? opts.ttlSec : null;
    await this.q(
      `INSERT INTO ${this.S}.kv (tenant_id, key, value, expires_at, updated_at)
       VALUES ($1, $2, $3::jsonb, CASE WHEN $4::double precision IS NULL THEN NULL ELSE now() + make_interval(secs => $4::double precision) END, now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, updated_at = now()`,
      [this.tenant, key, json, ttl],
    );
  }

  async kvDelete(key: string): Promise<void> {
    await this.q(`DELETE FROM ${this.S}.kv WHERE tenant_id = $1 AND key = $2`, [this.tenant, key]);
  }

  async kvList(prefix: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ keys: string[]; cursor?: string }> {
    const limit = clampLimit(opts.limit, 100, 1000);
    const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.q<{ key: string }>(
      `SELECT key FROM ${this.S}.kv
       WHERE tenant_id = $1 AND key LIKE $2 ESCAPE '\\' AND key > $3 AND (expires_at IS NULL OR expires_at > now())
       ORDER BY key LIMIT $4`,
      [this.tenant, pattern, opts.cursor ?? '', limit + 1],
    );
    const keys = rows.slice(0, limit).map((r) => r.key);
    return rows.length > limit ? { keys, cursor: keys.at(-1) } : { keys };
  }

  /** Deletes this tenant's expired keys and returns how many were removed. Reads already ignore them. */
  async kvPurgeExpired(): Promise<number> {
    const rows = await this.q<{ n: number }>(
      `WITH d AS (DELETE FROM ${this.S}.kv WHERE tenant_id = $1 AND expires_at <= now() RETURNING 1) SELECT count(*)::int AS n FROM d`,
      [this.tenant],
    );
    return Number(rows[0]?.n ?? 0);
  }

  // -------------------------------------------------------------- vectors

  private pgvectorVersion(): Promise<string> {
    this.s.pgvector ??= this.q<{ v: string }>(`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`).then(
      (rows) => rows[0]?.v ?? '0',
    );
    return this.s.pgvector;
  }

  private async supportsIterativeScan(): Promise<boolean> {
    const [major = 0, minor = 0] = (await this.pgvectorVersion()).split('.').map(Number);
    return major > 0 || minor >= 8;
  }

  /** Index name for a model: stable, short, safe. */
  static async indexName(model: string, dimensions: number): Promise<string> {
    return `vectors_hnsw_${(await sha256Hex(`${model}\u0000${dimensions}`)).slice(0, 16)}`;
  }

  /**
   * Registers a model's dimension count on first use and creates its partial
   * HNSW index, under an advisory lock so concurrent writers never race on
   * CREATE INDEX. A model keeps one dimension count for its lifetime.
   */
  private async ensureModel(model: string, dimensions: number): Promise<{ dimensions: number; index: 'vector' | 'halfvec' | null }> {
    const known = this.s.vectorModels.get(model);
    if (known) {
      if (known.dimensions !== dimensions) throw this.dimensionMismatch(model, known.dimensions, dimensions);
      return known;
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > 16000) {
      throw new Vid2ContextError('bad-request', `Unsupported vector size ${dimensions} for model ${model}.`, {
        hint: 'pgvector stores 1 to 16000 dimensions.',
      });
    }
    const S = this.S;
    const lock = { text: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: [`vid2context:vector-model:${this.s.schema}`] };
    const type = indexTypeFor(dimensions);
    const name = type ? await PostgresStorage.indexName(model, dimensions) : null;
    const [, , rows] = await this.tx([
      lock,
      {
        text: `INSERT INTO ${S}.vector_models (model, dimensions, index_name) VALUES ($1, $2, $3) ON CONFLICT (model) DO NOTHING`,
        params: [model, dimensions, name],
      },
      { text: `SELECT dimensions FROM ${S}.vector_models WHERE model = $1`, params: [model] },
    ]);
    const stored = Number(rows?.[0]?.dimensions);
    if (stored !== dimensions) throw this.dimensionMismatch(model, stored, dimensions);
    if (type && name) {
      const ops = type === 'vector' ? 'vector_cosine_ops' : 'halfvec_cosine_ops';
      await this.tx([
        lock,
        {
          text: `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${S}.vectors USING hnsw ((embedding::${type}(${dimensions})) ${ops}) WHERE model = ${quoteLiteral(model)}`,
        },
      ]);
    }
    const entry = { dimensions, index: type };
    this.s.vectorModels.set(model, entry);
    return entry;
  }

  private async lookupModel(model: string): Promise<{ dimensions: number; index: 'vector' | 'halfvec' | null } | null> {
    const known = this.s.vectorModels.get(model);
    if (known) return known;
    const rows = await this.q<{ dimensions: number }>(`SELECT dimensions FROM ${this.S}.vector_models WHERE model = $1`, [model]);
    const dims = rows[0] ? Number(rows[0].dimensions) : null;
    if (!dims) return null;
    const entry = { dimensions: dims, index: indexTypeFor(dims) };
    this.s.vectorModels.set(model, entry);
    return entry;
  }

  private dimensionMismatch(model: string, stored: number, got: number): Vid2ContextError {
    return new Vid2ContextError('bad-request', `Model ${model} stores ${stored}-dimension vectors, got ${got}.`, {
      hint: 'Vectors from one model always have one size. Use a different model id for a different embedding size.',
    });
  }

  async upsertVectors(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const byModel = new Map<string, VectorRecord[]>();
    for (const r of records) {
      const list = byModel.get(r.model) ?? [];
      list.push(r);
      byModel.set(r.model, list);
    }
    const statements: Statement[] = [];
    for (const [model, list] of byModel) {
      const dims = list[0]?.vector.length ?? 0;
      await this.ensureModel(model, dims);
      for (const r of list) if (r.vector.length !== dims) throw this.dimensionMismatch(model, dims, r.vector.length);
      for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500).map((r) => ({
          id: r.id,
          video_id: r.videoId,
          start_sec: r.startSec,
          end_sec: r.endSec,
          text: r.text,
          embedding: vectorLiteral(r.vector),
        }));
        statements.push({
          text: `INSERT INTO ${this.S}.vectors (tenant_id, model, id, video_id, start_sec, end_sec, text, embedding, updated_at)
            SELECT $1, $2, r.id, r.video_id, r.start_sec, r.end_sec, r.text, r.embedding::vector, now()
            FROM jsonb_to_recordset($3::jsonb) AS r(id text, video_id text, start_sec double precision, end_sec double precision, text text, embedding text)
            ON CONFLICT (tenant_id, model, id) DO UPDATE SET video_id = excluded.video_id, start_sec = excluded.start_sec,
              end_sec = excluded.end_sec, text = excluded.text, embedding = excluded.embedding, updated_at = now()`,
          params: [this.tenant, model, JSON.stringify(chunk)],
        });
      }
    }
    await this.tx(statements);
  }

  async deleteVectors(filter: { videoId: string; model?: string }): Promise<void> {
    await this.q(`DELETE FROM ${this.S}.vectors WHERE tenant_id = $1 AND video_id = $2 AND ($3::text IS NULL OR model = $3::text)`, [
      this.tenant,
      filter.videoId,
      filter.model ?? null,
    ]);
  }

  /** The SQL a vector query runs. Exposed so tests and operators can EXPLAIN it. */
  async vectorQuerySql(query: VectorQuery): Promise<{ statements: Statement[]; exact: Statement } | null> {
    const info = await this.lookupModel(query.model);
    if (!info) return null;
    if (query.vector.length !== info.dimensions) throw this.dimensionMismatch(query.model, info.dimensions, query.vector.length);
    const limit = clampLimit(query.limit, 20, 1000);
    const params: Param[] = [this.tenant, vectorLiteral(query.vector), limit];
    let filter = '';
    if (query.videoIds !== undefined) {
      params.push(JSON.stringify(query.videoIds));
      filter = ` AND video_id IN (SELECT jsonb_array_elements_text($4::jsonb))`;
    }
    const cols = 'id, video_id, start_sec, end_sec, text';
    const where = `tenant_id = $1 AND model = ${quoteLiteral(query.model)}${filter}`;
    // Exact scan: plain cosine distance on the untyped column, which no index matches.
    const exact: Statement = {
      text: `SELECT ${cols}, 1 - (embedding <=> $2::vector) AS score FROM ${this.S}.vectors WHERE ${where} ORDER BY embedding <=> $2::vector LIMIT $3`,
      params,
    };
    if (!info.index) return { statements: [exact], exact };
    const t = `${info.index}(${info.dimensions})`;
    const expr = `(embedding::${t}) <=> ($2::vector)::${t}`;
    const statements: Statement[] = [{ text: `SET LOCAL hnsw.ef_search = ${Math.min(1000, Math.max(40, limit * 2))}` }];
    // pgvector 0.8 keeps scanning the graph until enough rows pass the tenant and video filters.
    if (await this.supportsIterativeScan()) statements.push({ text: 'SET LOCAL hnsw.iterative_scan = strict_order' });
    statements.push({ text: `SELECT ${cols}, 1 - (${expr}) AS score FROM ${this.S}.vectors WHERE ${where} ORDER BY ${expr} LIMIT $3`, params });
    return { statements, exact };
  }

  async queryVectors(query: VectorQuery): Promise<VectorHit[]> {
    const plan = await this.vectorQuerySql(query);
    if (!plan) return [];
    const limit = clampLimit(query.limit, 20, 1000);
    let rows = (await this.tx(plan.statements)).at(-1) ?? [];
    // An approximate index scan can return fewer rows than exist after filtering
    // (old pgvector without iterative scans, or a very selective filter). Then
    // the exact scan gives the true answer.
    if (rows.length < limit && plan.statements.length > 1) rows = await this.q(plan.exact.text, plan.exact.params);
    return rows.map((r) => ({
      id: String(r.id),
      videoId: String(r.video_id),
      startSec: Number(r.start_sec),
      endSec: Number(r.end_sec),
      text: String(r.text),
      score: Number(r.score),
    }));
  }
}
