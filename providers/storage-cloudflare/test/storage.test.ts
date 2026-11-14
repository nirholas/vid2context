/**
 * The Storage contract on real local Cloudflare engines: Miniflare runs
 * workerd's own D1 (SQLite with FTS5), R2 and KV implementations in memory.
 * Data is the shared real fixtures in tests/fixtures/.
 */
import { readFileSync } from 'node:fs';
import { type Ctx, createContext, hasKv, hasVectors, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import provider, {
  CloudflareStorage,
  type D1Database,
  ensureSchema,
  ftsQuery,
  KV_MIN_TTL_SEC,
  type KVNamespace,
  MIGRATIONS,
  migrationSql,
  type R2Bucket,
} from '../src/index.ts';

const context = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8')) as VideoContext;
const zoo = context('youtube-jNQXAC9IVRw.json');
const gwagon = context('youtube-cCPsdFdlshc.json');
const apollo = new Uint8Array(readFileSync(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url)));

let mf: Miniflare;
let bindings: Record<string, unknown>;
let db: D1Database;
let plainDb: D1Database;
let r2: R2Bucket;
let kv: KVNamespace;

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'vid2context-test', PLAIN_DB: 'vid2context-plain' },
      r2Buckets: ['R2'],
      kvNamespaces: ['KV'],
    }),
  );
  bindings = await mf.getBindings();
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  plainDb = (await mf.getD1Database('PLAIN_DB')) as unknown as D1Database;
  r2 = (await mf.getR2Bucket('R2')) as unknown as R2Bucket;
  kv = (await mf.getKVNamespace('KV')) as unknown as KVNamespace;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

/** A Workers context with the Miniflare bindings; createWorkersContext itself is tested in plumbing.test.ts. */
function workersCtx(env: Record<string, string>, withBindings = true): Ctx {
  return createContext({ runtime: 'workers', env, bindings: withBindings ? bindings : undefined });
}

describe('provider', () => {
  it('is enabled by VID2CONTEXT_D1 unless VID2CONTEXT_STORAGE picks another backend, and runs only on workers', () => {
    expect(provider.isEnabled({})).toBe(false);
    expect(provider.isEnabled({ VID2CONTEXT_D1: 'DB' })).toBe(true);
    expect(provider.isEnabled({ VID2CONTEXT_D1: 'DB', VID2CONTEXT_STORAGE: 'cloudflare' })).toBe(true);
    expect(provider.isEnabled({ VID2CONTEXT_D1: 'DB', VID2CONTEXT_STORAGE: 'memory' })).toBe(false);
    expect(provider.runtimes).toEqual(['workers']);
  });

  it('creates a storage from the bindings named in env, with KV and without vectors', async () => {
    const ctx = workersCtx({ VID2CONTEXT_D1: 'DB', VID2CONTEXT_R2: 'R2', VID2CONTEXT_KV: 'KV' });
    const storage = await provider.create(ctx);
    expect(storage.backend).toBe('cloudflare-d1');
    expect(hasKv(storage)).toBe(true);
    expect(hasVectors(storage)).toBe(false);
  });

  it('fails with a wrangler.jsonc hint when a named binding is missing', async () => {
    const ctx = workersCtx({ VID2CONTEXT_D1: 'DB', VID2CONTEXT_R2: 'MEDIA' });
    const err = (await provider.create(ctx).catch((e: unknown) => e)) as Vid2ContextError;
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err.code).toBe('no-provider');
    expect(err.hint).toMatch(/"r2_buckets"/);
    const noD1 = (await provider
      .create(workersCtx({ VID2CONTEXT_D1: 'DB' }, false))
      .catch((e: unknown) => e)) as Vid2ContextError;
    expect(noD1.hint).toMatch(/"d1_databases"/);
  });
});

describe('schema', () => {
  it('keeps migrations/*.sql identical to src/migrations.ts', () => {
    for (const m of MIGRATIONS) {
      const file = readFileSync(new URL(`../migrations/${m.name}.sql`, import.meta.url), 'utf8');
      expect(file).toBe(migrationSql(m));
    }
  });

  it('applies the schema once, records the version and is safe to run again', async () => {
    await ensureSchema(plainDb);
    const fresh = { prepare: plainDb.prepare.bind(plainDb), batch: plainDb.batch.bind(plainDb) };
    await ensureSchema(fresh);
    const rows = await plainDb.prepare('SELECT version FROM schema_version').all<{ version: number }>();
    expect(rows.results.map((r) => r.version)).toEqual([1]);
  });
});

describe('Storage contract on D1 with R2 and KV', () => {
  let s: CloudflareStorage;

  beforeAll(async () => {
    await ensureSchema(db);
    s = new CloudflareStorage({ db, r2, kv });
    await s.putContext(zoo);
    await s.putContext(gwagon);
  });

  it('returns saved contexts unchanged and null for unknown ids', async () => {
    expect(await s.getContext('youtube:jNQXAC9IVRw')).toEqual(zoo);
    expect(await s.getContext('youtube:cCPsdFdlshc')).toEqual(gwagon);
    expect(await s.getContext('youtube:nope')).toBeNull();
  });

  it('lists summaries newest first with a cursor', async () => {
    const first = await s.listContexts({ limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual(['youtube:cCPsdFdlshc']);
    expect(first.items[0]).toMatchObject({
      title: gwagon.metadata.title,
      origin: 'auto-captions',
      language: 'en',
      ref: gwagon.metadata.ref,
    });
    expect(first.cursor).toBeTypeOf('string');
    const second = await s.listContexts({ limit: 1, cursor: first.cursor });
    expect(second.items.map((i) => i.id)).toEqual(['youtube:jNQXAC9IVRw']);
    expect(second.items[0]?.channel).toBe(zoo.metadata.channel?.name);
    expect(second.cursor).toBeUndefined();
    await expect(s.listContexts({ cursor: 'not a cursor' })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('finds words that occur in the transcripts, ranked by bm25', async () => {
    const hits = await s.search({ text: 'elephants' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      videoId: 'youtube:jNQXAC9IVRw',
      title: 'Me at the zoo',
      text: 'All right, so here we are, in front of the elephants',
    });
    expect(hits[0]?.score).toBeGreaterThan(0);

    const trans = await s.search({ text: 'transmission' });
    expect(trans.length).toBe(4);
    for (const h of trans) expect(h.text.toLowerCase()).toContain('transmission');

    const both = await s.search({ text: 'really long trunks' });
    expect(both[0]?.text).toBe('really really long trunks');
    for (let i = 1; i < both.length; i++) expect(both[i - 1]?.score).toBeGreaterThanOrEqual(both[i]?.score ?? 0);
  });

  it('treats FTS5 syntax in the query as plain words', async () => {
    expect(ftsQuery('"elephants" OR NEAR(zoo*) -trunks AND')).toBe('"elephants" OR "or" OR "near" OR "zoo" OR "trunks" OR "and"');
    expect(ftsQuery('   ?! ')).toBeNull();
    const hits = await s.search({ text: '"elephants) AND (' });
    expect(hits.map((h) => h.videoId)).toContain('youtube:jNQXAC9IVRw');
    expect(await s.search({ text: '***' })).toEqual([]);
  });

  it('restricts search to videoIds and to a collection', async () => {
    expect(await s.search({ text: 'elephants', videoIds: ['youtube:cCPsdFdlshc'] })).toEqual([]);
    const c = await s.createCollection({ name: 'Cars' });
    await s.addToCollection(c.id, ['youtube:cCPsdFdlshc']);
    expect(await s.search({ text: 'elephants', collectionId: c.id })).toEqual([]);
    expect((await s.search({ text: 'transmission', collectionId: c.id })).length).toBe(4);
    expect(await s.search({ text: 'transmission', collectionId: 'no-such-collection' })).toEqual([]);
    await s.deleteCollection(c.id);
  });

  it('honours the search limit', async () => {
    const hits = await s.search({ text: 'the', limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it('manages collections', async () => {
    const c = await s.createCollection({
      name: 'Zoo & cars!',
      description: 'Test set',
      sources: ['https://www.youtube.com/@jawed'],
    });
    expect(c.id).toMatch(/^zoo-cars-[0-9a-f]{8}$/);
    expect(c).toMatchObject({
      name: 'Zoo & cars!',
      description: 'Test set',
      sources: ['https://www.youtube.com/@jawed'],
      videoIds: [],
    });

    const added = await s.addToCollection(c.id, ['youtube:jNQXAC9IVRw', 'youtube:cCPsdFdlshc', 'youtube:jNQXAC9IVRw']);
    expect(added.videoIds).toEqual(['youtube:jNQXAC9IVRw', 'youtube:cCPsdFdlshc']);
    const again = await s.addToCollection(c.id, ['youtube:jNQXAC9IVRw']);
    expect(again.videoIds).toEqual(['youtube:jNQXAC9IVRw', 'youtube:cCPsdFdlshc']);

    const removed = await s.removeFromCollection(c.id, ['youtube:jNQXAC9IVRw']);
    expect(removed.videoIds).toEqual(['youtube:cCPsdFdlshc']);

    const renamed = await s.updateCollection(c.id, { name: 'Cars', description: undefined });
    expect(renamed.name).toBe('Cars');
    expect(renamed.description).toBeUndefined();
    expect(renamed.sources).toEqual(['https://www.youtube.com/@jawed']);

    const list = await s.listCollections();
    expect(list.find((x) => x.id === c.id)?.videoIds).toEqual(['youtube:cCPsdFdlshc']);
    expect(await s.getCollection(c.id)).toEqual(list.find((x) => x.id === c.id));

    await s.deleteCollection(c.id);
    expect(await s.getCollection(c.id)).toBeNull();
    const items = await db
      .prepare('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?')
      .bind(c.id)
      .first<{ n: number }>();
    expect(items?.n).toBe(0);
  });

  it('throws not-found for unknown collections', async () => {
    for (const call of [
      () => s.updateCollection('nope', { name: 'x' }),
      () => s.addToCollection('nope', ['youtube:jNQXAC9IVRw']),
      () => s.removeFromCollection('nope', ['youtube:jNQXAC9IVRw']),
    ]) {
      const err = (await call().catch((e: unknown) => e)) as Vid2ContextError;
      expect(err).toBeInstanceOf(Vid2ContextError);
      expect(err.code).toBe('not-found');
    }
  });

  it('replaces a context on re-save without duplicating its segments', async () => {
    await s.putContext(zoo);
    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM segments WHERE video_id = ?')
      .bind('youtube:jNQXAC9IVRw')
      .first<{ n: number }>();
    expect(n?.n).toBe(zoo.transcript.segments.length);
    expect(await s.search({ text: 'elephants' })).toHaveLength(1);
  });

  it('deletes a context with its segments, search rows and collection memberships', async () => {
    const c = await s.createCollection({ name: 'Zoo' });
    await s.addToCollection(c.id, ['youtube:jNQXAC9IVRw']);
    await s.deleteContext('youtube:jNQXAC9IVRw');
    expect(await s.getContext('youtube:jNQXAC9IVRw')).toBeNull();
    expect(await s.search({ text: 'elephants' })).toEqual([]);
    expect((await s.getCollection(c.id))?.videoIds).toEqual([]);
    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM segments WHERE video_id = ?')
      .bind('youtube:jNQXAC9IVRw')
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
    await s.deleteContext('youtube:jNQXAC9IVRw');
    await s.putContext(zoo);
  });
});

describe('R2 for large contexts and blobs', () => {
  it('stores a context over the threshold in R2, keeps the key in D1, and cleans up', async () => {
    await ensureSchema(db);
    const bytes = new TextEncoder().encode(JSON.stringify(gwagon)).byteLength;
    expect(bytes).toBeGreaterThan(30_000);
    const big = new CloudflareStorage({ db, r2, r2ThresholdBytes: 30_000 });
    await big.putContext(gwagon);

    const row = await db
      .prepare('SELECT context, r2_key FROM videos WHERE id = ?')
      .bind('youtube:cCPsdFdlshc')
      .first<{ context: string | null; r2_key: string | null }>();
    expect(row?.context).toBeNull();
    expect(row?.r2_key).toBe('contexts/youtube%3AcCPsdFdlshc.json');
    expect(await r2.get('contexts/youtube%3AcCPsdFdlshc.json')).not.toBeNull();
    expect(await big.getContext('youtube:cCPsdFdlshc')).toEqual(gwagon);
    expect((await big.search({ text: 'transmission' })).length).toBe(4);

    // Saved again under the default threshold it moves back into D1 and the R2 object is removed.
    const normal = new CloudflareStorage({ db, r2 });
    await normal.putContext(gwagon);
    expect(await r2.get('contexts/youtube%3AcCPsdFdlshc.json')).toBeNull();

    await big.putContext(gwagon);
    await big.deleteContext('youtube:cCPsdFdlshc');
    expect(await r2.get('contexts/youtube%3AcCPsdFdlshc.json')).toBeNull();
    await normal.putContext(gwagon);
  });

  it('cannot read an R2-backed context without the bucket', async () => {
    const big = new CloudflareStorage({ db, r2, r2ThresholdBytes: 30_000 });
    await big.putContext(gwagon);
    const noBucket = new CloudflareStorage({ db });
    await expect(noBucket.getContext('youtube:cCPsdFdlshc')).rejects.toMatchObject({ code: 'unavailable' });
    await new CloudflareStorage({ db, r2 }).putContext(gwagon);
  });

  it('stores uploaded media as blobs', async () => {
    const s = new CloudflareStorage({ db, r2 });
    await s.putBlob('apollo.mp3', apollo, 'audio/mpeg');
    const blob = await s.getBlob('apollo.mp3');
    expect(blob?.contentType).toBe('audio/mpeg');
    expect(blob?.data).toEqual(apollo);
    await s.deleteBlob('apollo.mp3');
    expect(await s.getBlob('apollo.mp3')).toBeNull();
    await expect(new CloudflareStorage({ db }).putBlob('x', apollo)).rejects.toMatchObject({ code: 'no-provider' });
  });
});

describe('KvStore on Workers KV', () => {
  it('gets, sets, deletes and lists by prefix with a cursor', async () => {
    const s = new CloudflareStorage({ db, kv });
    await s.kvSet('jobs:b', { n: 2 });
    await s.kvSet('jobs:a', { n: 1 });
    await s.kvSet('jobs:c', [3]);
    await s.kvSet('cache:x', 'x');
    expect(await s.kvGet('jobs:a')).toEqual({ n: 1 });
    expect(await s.kvGet('jobs:missing')).toBeNull();

    const page1 = await s.kvList('jobs:', { limit: 2 });
    expect(page1.keys).toEqual(['jobs:a', 'jobs:b']);
    expect(page1.cursor).toBeTypeOf('string');
    const page2 = await s.kvList('jobs:', { limit: 2, cursor: page1.cursor });
    expect(page2).toEqual({ keys: ['jobs:c'] });

    await s.kvDelete('jobs:b');
    expect(await s.kvGet('jobs:b')).toBeNull();
    expect((await s.kvList('jobs:')).keys).toEqual(['jobs:a', 'jobs:c']);
  });

  it('raises TTLs below 60 seconds to the KV minimum', async () => {
    const s = new CloudflareStorage({ db, kv });
    const before = Math.floor(Date.now() / 1000);
    await s.kvSet('ratelimit:short', 1, { ttlSec: 1 });
    await s.kvSet('ratelimit:long', 1, { ttlSec: 3600 });
    const { keys } = await kv.list({ prefix: 'ratelimit:' });
    const exp = Object.fromEntries(keys.map((k) => [k.name, k.expiration ?? 0]));
    expect(exp['ratelimit:short']).toBeGreaterThanOrEqual(before + KV_MIN_TTL_SEC);
    expect(exp['ratelimit:short']).toBeLessThanOrEqual(before + KV_MIN_TTL_SEC + 5);
    expect(exp['ratelimit:long']).toBeGreaterThanOrEqual(before + 3600);
  });
});

describe('KvStore in a D1 table when no KV namespace is bound', () => {
  it('gets, sets, deletes and lists by prefix with a cursor', async () => {
    await ensureSchema(plainDb);
    const s = new CloudflareStorage({ db: plainDb });
    await s.kvSet('library:2', { id: 2 });
    await s.kvSet('library:1', { id: 1 });
    await s.kvSet('library:3', null);
    await s.kvSet('libraryx', 'not in prefix');
    const page1 = await s.kvList('library:', { limit: 2 });
    expect(page1).toEqual({ keys: ['library:1', 'library:2'], cursor: 'library:2' });
    expect(await s.kvList('library:', { limit: 2, cursor: page1.cursor })).toEqual({ keys: ['library:3'] });
    expect(await s.kvGet('library:1')).toEqual({ id: 1 });
    await s.kvDelete('library:1');
    expect(await s.kvGet('library:1')).toBeNull();
  });

  it('expires values after their TTL', async () => {
    const s = new CloudflareStorage({ db: plainDb });
    await s.kvSet('cache:soon', { v: 1 }, { ttlSec: 1 });
    await s.kvSet('cache:later', { v: 2 }, { ttlSec: 600 });
    expect(await s.kvGet('cache:soon')).toEqual({ v: 1 });
    await new Promise((r) => setTimeout(r, 1200));
    expect(await s.kvGet('cache:soon')).toBeNull();
    expect((await s.kvList('cache:')).keys).toEqual(['cache:later']);
  });
});
