import type { PGlite } from '@electric-sql/pglite';
import { hasKv, hasVectors, MemoryStorage, Registry, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import provider, {
  createPostgresStorage,
  isPostgresEnabled,
  migrate,
  migrations,
  type PostgresStorage,
  readConfig,
  scrub,
  secretsOf,
  toStorageError,
  tsConfigFor,
} from '../src/index.ts';
import { storageContract } from './contract.ts';
import { loadContext, loadEmbeddings } from './fixtures.ts';
import { newPGlite, pgliteDb } from './pglite.ts';

const zoo = loadContext('youtube-jNQXAC9IVRw.json');
const gwagon = loadContext('youtube-cCPsdFdlshc.json');
const ZOO = zoo.metadata.ref.id;
const GW = gwagon.metadata.ref.id;

// The reference implementation must pass the same suite, which keeps it honest.
storageContract('MemoryStorage (reference)', async () => ({ storage: new MemoryStorage(), done: async () => {} }));

storageContract('PostgresStorage on PGlite', async () => {
  const pg = await newPGlite();
  const { storage } = await createPostgresStorage({ db: pgliteDb(pg) });
  return { storage, done: () => pg.close() };
});

describe('PostgresStorage on PGlite', () => {
  let pg: PGlite;
  let storage: PostgresStorage;

  beforeAll(async () => {
    pg = await newPGlite();
    ({ storage } = await createPostgresStorage({ db: pgliteDb(pg), tenant: 'acme' }));
    await storage.putContext(zoo);
    await storage.putContext(gwagon);
  });
  afterAll(async () => {
    await pg.close();
  });

  describe('migrations', () => {
    it('applies every migration on first run and nothing on later runs', async () => {
      const fresh = await newPGlite();
      const db = pgliteDb(fresh);
      const first = await migrate(db, 'lib');
      expect(first.applied).toEqual(migrations.map((m) => m.version));
      const second = await migrate(db, 'lib');
      expect(second).toEqual({ applied: [], version: first.version });
      const rows = (await fresh.query<{ version: number }>('SELECT version FROM lib.schema_migrations ORDER BY version')).rows;
      expect(rows.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
      await fresh.close();
    });

    it('rechecks under the lock, so a stale caller does not reapply a migration', async () => {
      const fresh = await newPGlite();
      const db = pgliteDb(fresh);
      await migrate(db, 'lib');
      // Simulate an instance that read the version before another one migrated:
      // it takes the slow path, and the DO blocks see every version applied.
      const before = (await fresh.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'lib'"))
        .rows[0]?.n;
      await fresh.query('DELETE FROM lib.schema_migrations WHERE version = $1', [migrations.at(-1)?.version]);
      const again = await migrate(db, 'lib');
      expect(again.applied).toEqual([migrations.at(-1)?.version]);
      const after = (await fresh.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'lib'"))
        .rows[0]?.n;
      expect(after).toBe(before);
      await fresh.close();
    });

    it('keeps each schema separate', async () => {
      const fresh = await newPGlite();
      const a = await createPostgresStorage({ db: pgliteDb(fresh), schema: 'one' });
      const b = await createPostgresStorage({ db: pgliteDb(fresh), schema: 'two' });
      await a.storage.putContext(zoo);
      expect(await a.storage.getContext(ZOO)).not.toBeNull();
      expect(await b.storage.getContext(ZOO)).toBeNull();
      await fresh.close();
    });
  });

  describe('full-text search', () => {
    it('stems with the transcript language configuration', async () => {
      expect(tsConfigFor('en')).toBe('english');
      expect(tsConfigFor('pt-BR')).toBe('portuguese');
      expect(tsConfigFor('ja')).toBe('simple');
      const row = (await pg.query<{ c: string }>(`SELECT ts_config::text AS c FROM vid2context.videos WHERE id = $1`, [ZOO]))
        .rows[0];
      expect(row?.c).toBe('english');
      // "elephant" matches "elephants" through the English stemmer.
      const hits = await storage.search({ text: 'elephant' });
      expect(hits[0]).toMatchObject({ videoId: ZOO, startSec: zoo.transcript.segments[0]?.startSec });
    });

    it('ranks, highlights and keeps the raw segment text', async () => {
      const hits = await storage.search({ text: 'transmission' });
      expect(hits.length).toBe(gwagon.transcript.segments.filter((s) => /transmission/i.test(s.text)).length);
      for (const h of hits) {
        expect(h.videoId).toBe(GW);
        expect(h.score).toBeGreaterThan(0);
        expect(h.score).toBeLessThan(1);
        expect(h.snippet).toMatch(/\*\*transmission\w*\*\*/i);
        expect(gwagon.transcript.segments.some((s) => s.text === h.text && s.startSec === h.startSec)).toBe(true);
      }
      const scores = hits.map((h) => h.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });

    it('handles quoted phrases and -exclusions with websearch syntax', async () => {
      const phrase = await storage.search({ text: '"really long trunks"' });
      expect(phrase.map((h) => h.text)).toEqual(['really really long trunks']);
      const loose = await storage.search({ text: 'really' });
      expect(loose.length).toBeGreaterThan(1);
      const excluded = await storage.search({ text: 'really -trunks' });
      expect(excluded.length).toBe(loose.length - 1);
      expect(excluded.every((h) => !h.text.includes('trunks'))).toBe(true);
      const either = await storage.search({ text: 'elephants or transmission' });
      expect(new Set(either.map((h) => h.videoId))).toEqual(new Set([ZOO, GW]));
    });

    it('accepts hostile input without SQL errors', async () => {
      for (const text of ["'; DROP TABLE vid2context.videos; --", '"unclosed', '!!! & | <-> :*', 'a\\b', '-', '""']) {
        await expect(storage.search({ text })).resolves.toBeInstanceOf(Array);
      }
      expect(await storage.getContext(ZOO)).not.toBeNull();
    });

    it('can serve segment matches from the GIN index', async () => {
      // On a table this small the tenant's primary key is cheaper, so the
      // other paths are switched off to show the GIN index matches @@.
      await pg.exec('SET enable_seqscan = off');
      const plan = (
        await pg.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT idx FROM vid2context.segments WHERE tsv @@ websearch_to_tsquery('english', 'transmission')`,
        )
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      await pg.exec('RESET enable_seqscan');
      expect(plan).toContain('segments_tsv_idx');
    });
  });

  describe('tenancy', () => {
    it('isolates two tenants that save the same video id', async () => {
      const other = storage.forTenant('globex');
      expect(await other.getContext(ZOO)).toBeNull();
      expect(await other.search({ text: 'elephants' })).toEqual([]);
      expect((await other.listContexts()).items).toEqual([]);

      const edited = { ...zoo, metadata: { ...zoo.metadata, title: 'Globex copy' } };
      await other.putContext(edited);
      expect((await other.getContext(ZOO))?.metadata.title).toBe('Globex copy');
      expect((await storage.getContext(ZOO))?.metadata.title).toBe(zoo.metadata.title);

      const c = await other.createCollection({ name: 'Globex only' });
      expect(await storage.getCollection(c.id)).toBeNull();
      await expect(storage.addToCollection(c.id, [ZOO])).rejects.toMatchObject({ code: 'not-found' });

      await other.kvSet('library:x', { owner: 'globex' });
      expect(await storage.kvGet('library:x')).toBeNull();

      await other.deleteContext(ZOO);
      expect(await storage.getContext(ZOO)).not.toBeNull();
      expect((await storage.search({ text: 'elephants' })).length).toBeGreaterThan(0);
    });
  });

  describe('KvStore', () => {
    it('is detected by hasKv and hasVectors', () => {
      expect(hasKv(storage)).toBe(true);
      expect(hasVectors(storage)).toBe(true);
    });

    it('stores JSON values, overwrites and deletes', async () => {
      await storage.kvSet('jobs:1', { state: 'queued', n: 1, tags: ['a'] });
      expect(await storage.kvGet('jobs:1')).toEqual({ state: 'queued', n: 1, tags: ['a'] });
      await storage.kvSet('jobs:1', 'done');
      expect(await storage.kvGet('jobs:1')).toBe('done');
      await storage.kvSet('jobs:null', null);
      expect(await storage.kvGet('jobs:null')).toBeNull();
      await storage.kvDelete('jobs:1');
      expect(await storage.kvGet('jobs:1')).toBeNull();
      await expect(storage.kvSet('jobs:bad', undefined)).rejects.toMatchObject({ code: 'bad-request' });
    });

    it('expires values after their TTL', async () => {
      await storage.kvSet('cache:short', 1, { ttlSec: 0.05 });
      await storage.kvSet('cache:long', 2, { ttlSec: 3600 });
      expect(await storage.kvGet('cache:short')).toBe(1);
      await new Promise((r) => setTimeout(r, 120));
      expect(await storage.kvGet('cache:short')).toBeNull();
      expect(await storage.kvGet('cache:long')).toBe(2);
      expect((await storage.kvList('cache:')).keys).toEqual(['cache:long']);
      await storage.kvSet('cache:gone', 3, { ttlSec: 0.01 });
      await new Promise((r) => setTimeout(r, 50));
      expect(await storage.kvPurgeExpired()).toBe(1);
    });

    it('lists by prefix in lexical order with cursors, treating LIKE wildcards literally', async () => {
      for (const k of ['auth:apikey:b', 'auth:apikey:a', 'auth:apikey:c', 'auth:oauth:a', 'auth_apikey:x', 'auth%apikey:y'])
        await storage.kvSet(k, k);
      const p1 = await storage.kvList('auth:apikey:', { limit: 2 });
      expect(p1).toEqual({ keys: ['auth:apikey:a', 'auth:apikey:b'], cursor: 'auth:apikey:b' });
      const p2 = await storage.kvList('auth:apikey:', { limit: 2, cursor: p1.cursor });
      expect(p2).toEqual({ keys: ['auth:apikey:c'] });
      expect((await storage.kvList('auth_')).keys).toEqual(['auth_apikey:x']);
      expect((await storage.kvList('auth%')).keys).toEqual(['auth%apikey:y']);
    });
  });

  describe('VectorStore with recorded bge-m3 embeddings', () => {
    const fx = loadEmbeddings();
    const model = 'embed/ovh/bge-m3';
    const vectorOf = (i: number) => fx.response.data.find((d) => d.index === i)?.embedding ?? [];
    const records = fx.chunks.map((c, i) => ({
      id: `${c.videoId}#${c.startSec}`,
      videoId: c.videoId,
      startSec: c.startSec,
      endSec: c.endSec,
      text: c.text,
      model,
      vector: vectorOf(i),
    }));
    const query = (q: number) => vectorOf(fx.chunks.length + q);

    beforeAll(async () => {
      expect(records[0]?.vector).toHaveLength(1024);
      await storage.upsertVectors(records);
    });

    it('returns the semantically closest chunks first, with cosine scores', async () => {
      const elephants = await storage.queryVectors({ model, vector: query(0), limit: 3 });
      expect(elephants).toHaveLength(3);
      expect(elephants[0]?.videoId).toBe(ZOO);
      expect(elephants[0]?.text).toMatch(/elephants|trunks/);
      expect(elephants[0]?.score).toBeGreaterThan(elephants[2]?.score ?? 1);
      expect(elephants[0]?.score).toBeLessThanOrEqual(1);

      const engines = await storage.queryVectors({ model, vector: query(1), limit: 3 });
      expect(engines.every((h) => h.videoId === GW)).toBe(true);
    });

    it('matches an exact cosine computed in JavaScript', async () => {
      const q = query(0);
      const cos = (a: number[], b: number[]) => {
        let d = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < a.length; i++) {
          d += (a[i] ?? 0) * (b[i] ?? 0);
          na += (a[i] ?? 0) ** 2;
          nb += (b[i] ?? 0) ** 2;
        }
        return d / Math.sqrt(na * nb);
      };
      const expected = records.map((r) => ({ id: r.id, s: cos(q, r.vector) })).sort((a, b) => b.s - a.s);
      const hits = await storage.queryVectors({ model, vector: q, limit: records.length });
      expect(hits.map((h) => h.id)).toEqual(expected.map((e) => e.id));
      expect(hits[0]?.score).toBeCloseTo(expected[0]?.s ?? 0, 5);
    });

    it('filters by video, keeps models apart and isolates tenants', async () => {
      const onlyGw = await storage.queryVectors({ model, vector: query(0), videoIds: [GW], limit: 50 });
      expect(onlyGw.length).toBe(records.filter((r) => r.videoId === GW).length);
      expect(onlyGw.every((h) => h.videoId === GW)).toBe(true);
      expect(await storage.queryVectors({ model: 'embed/other/model', vector: query(0) })).toEqual([]);
      expect(await storage.forTenant('globex').queryVectors({ model, vector: query(0) })).toEqual([]);
    });

    it('rejects a vector size that does not match the model', async () => {
      await expect(storage.queryVectors({ model, vector: query(0).slice(0, 10) })).rejects.toMatchObject({ code: 'bad-request' });
      await expect(storage.upsertVectors([{ ...(records[0] as (typeof records)[0]), vector: [1, 2, 3] }])).rejects.toMatchObject({
        code: 'bad-request',
      });
    });

    it('upserts by id and deletes by video and model', async () => {
      const first = records[0] as (typeof records)[0];
      await storage.upsertVectors([{ ...first, text: 'replaced text' }]);
      const hits = await storage.queryVectors({ model, vector: first.vector, limit: 1 });
      expect(hits[0]).toMatchObject({ id: first.id, text: 'replaced text' });
      await storage.upsertVectors([first]);
      await storage.deleteVectors({ videoId: ZOO, model: 'embed/other/model' });
      expect((await storage.queryVectors({ model, vector: query(0), videoIds: [ZOO], limit: 50 })).length).toBe(6);
      await storage.deleteVectors({ videoId: ZOO });
      expect(await storage.queryVectors({ model, vector: query(0), videoIds: [ZOO], limit: 50 })).toEqual([]);
      await storage.upsertVectors(records.filter((r) => r.videoId === ZOO));
    });

    it('creates one partial HNSW index per model that matches the query', async () => {
      const idx = (
        await pg.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE schemaname = 'vid2context' AND indexname LIKE 'vectors_hnsw_%'`,
        )
      ).rows;
      expect(idx).toHaveLength(1);
      expect(idx[0]?.indexdef).toMatch(
        /USING hnsw \(\(\(embedding\)::vector\(1024\)\) vector_cosine_ops\) WHERE \(model = 'embed\/ovh\/bge-m3'::text\)/,
      );

      const plan = await storage.vectorQuerySql({ model, vector: query(0), limit: 5 });
      const select = plan?.statements.at(-1);
      expect(select).toBeDefined();
      // With 12 rows, scanning the tenant's rows and sorting is cheaper than
      // the graph, so sorting is switched off to show the index matches the
      // query's predicate and ORDER BY. test/live.test.ts checks the real plan.
      await pg.exec('SET enable_seqscan = off; SET enable_sort = off');
      const explain = (await pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${select?.text}`, select?.params)).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      await pg.exec('RESET enable_seqscan; RESET enable_sort');
      expect(explain).toMatch(/Index Scan using vectors_hnsw_[0-9a-f]{16} on vectors/);
    });

    it('removes vectors with deleteContext', async () => {
      const t = storage.forTenant('vectors-delete');
      await t.putContext(zoo);
      await t.upsertVectors(records.filter((r) => r.videoId === ZOO));
      expect((await t.queryVectors({ model, vector: query(0) })).length).toBe(6);
      await t.deleteContext(ZOO);
      expect(await t.queryVectors({ model, vector: query(0) })).toEqual([]);
    });
  });
});

describe('provider wiring', () => {
  it('is enabled by a database URL and forced or disabled by VID2CONTEXT_STORAGE', () => {
    expect(isPostgresEnabled({})).toBe(false);
    expect(isPostgresEnabled({ DATABASE_URL: 'postgres://u:p@localhost/db' })).toBe(true);
    expect(isPostgresEnabled({ VID2CONTEXT_DATABASE_URL: 'postgres://u:p@localhost/db' })).toBe(true);
    expect(isPostgresEnabled({ DATABASE_URL: 'postgres://u:p@localhost/db', VID2CONTEXT_STORAGE: 'sqlite' })).toBe(false);
    expect(isPostgresEnabled({ VID2CONTEXT_STORAGE: 'postgres' })).toBe(true);
    expect(provider).toMatchObject({ id: 'storage-postgres', kind: 'storage', runtimes: ['node'] });
  });

  it('prefers VID2CONTEXT_DATABASE_URL and reads the other settings', () => {
    const c = readConfig(
      {
        DATABASE_URL: 'postgres://a@one/db',
        VID2CONTEXT_DATABASE_URL: 'postgresql://b@two/db?sslmode=require',
        VID2CONTEXT_PG_SCHEMA: 'lib_v2c',
        VID2CONTEXT_TENANT: 'team-7',
        VID2CONTEXT_PG_POOL_MAX: '3',
        VID2CONTEXT_PG_STATEMENT_TIMEOUT_MS: '15000',
      },
      'node',
    );
    expect(c).toMatchObject({
      url: 'postgresql://b@two/db?sslmode=require',
      schema: 'lib_v2c',
      tenant: 'team-7',
      poolMax: 3,
      statementTimeoutMs: 15000,
      driver: 'postgres',
    });
    expect(readConfig({ DATABASE_URL: 'postgres://a@one/db' }, 'node')).toMatchObject({
      schema: 'vid2context',
      tenant: 'default',
      poolMax: 10,
    });
  });

  it('rejects bad settings with hints naming the variable', () => {
    const bad = (env: Record<string, string>, runtime: 'node' | 'workers' = 'node') => {
      try {
        readConfig(env, runtime);
      } catch (err) {
        return err as Vid2ContextError;
      }
      throw new Error('expected an error');
    };
    expect(bad({}).hint).toContain('DATABASE_URL');
    expect(bad({ DATABASE_URL: 'mysql://x' }).hint).toContain('DATABASE_URL');
    expect(bad({ DATABASE_URL: 'postgres://x/db', VID2CONTEXT_PG_SCHEMA: 'Bad-Name' }).hint).toContain('VID2CONTEXT_PG_SCHEMA');
    expect(bad({ DATABASE_URL: 'postgres://x/db', VID2CONTEXT_PG_POOL_MAX: 'lots' }).hint).toContain('VID2CONTEXT_PG_POOL_MAX');
    expect(bad({ DATABASE_URL: 'postgres://x@db.example.com/db' }, 'workers').code).toBe('unsupported-input');
    expect(readConfig({ DATABASE_URL: 'postgres://x@ep-cool-1.us-east-2.aws.neon.tech/db' }, 'workers').driver).toBe('neon-http');
  });

  it('is what registry.openStorage picks when a URL is set, and nothing is picked without one', async () => {
    const registry = new Registry([provider], 'node');
    expect(await registry.openStorage(testContext({ env: {} }))).toBeNull();
    // A URL with an unreachable port proves the registry chose this backend: it tries to connect.
    const ctx = testContext({ env: { DATABASE_URL: 'postgres://v2c:s3cret-pass@127.0.0.1:1/v2c' } });
    const err = await registry.openStorage(ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('unavailable');
    expect((err as Vid2ContextError).hint).toContain('DATABASE_URL');
    expect((err as Vid2ContextError).message).not.toContain('s3cret-pass');
  });

  it('maps driver errors to codes and never leaks the connection string', () => {
    const url = 'postgres://admin:hunter2-very-secret@db.internal:5432/app';
    const secrets = secretsOf(url);
    const auth = toStorageError({ code: '28P01', message: `password authentication failed for ${url}` }, secrets);
    expect(auth.code).toBe('auth');
    expect(auth.message).not.toContain('hunter2');
    expect(auth.message).toContain('SQLSTATE 28P01');
    expect(toStorageError({ code: '57014', message: 'canceling statement due to statement timeout' }, secrets)).toMatchObject({
      code: 'timeout',
      hint: expect.stringContaining('VID2CONTEXT_PG_STATEMENT_TIMEOUT_MS'),
    });
    expect(toStorageError({ code: '0A000', message: 'extension "vector" is not available' }, secrets).hint).toContain('pgvector');
    expect(toStorageError({ code: '42501', message: 'permission denied for database app' }, secrets).hint).toContain(
      'VID2CONTEXT_PG_SCHEMA',
    );
    expect(toStorageError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND db.internal' }, secrets).code).toBe('unavailable');
    expect(scrub('see postgresql://x:y@h/d now', [])).toBe('see postgres://*** now');
  });

  it('turns SQL errors from the database into Vid2ContextError', async () => {
    const pg = await newPGlite();
    const { storage } = await createPostgresStorage({ db: pgliteDb(pg) });
    await pg.exec('DROP TABLE vid2context.kv');
    await expect(storage.kvGet('x')).rejects.toMatchObject({ name: 'Vid2ContextError', code: 'upstream' });
    await pg.close();
  });
});
