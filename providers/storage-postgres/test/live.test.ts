/**
 * LIVE=1 tests against a real Postgres server: DATABASE_URL when set, or a
 * throwaway pgvector/pgvector container (see live-db.ts). Each test uses its
 * own schema named v2c_live_<random> and drops it afterwards.
 */
import { randomBytes } from 'node:crypto';
import { createContext, type Ctx, type Env } from '@vid2context/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Db } from '../src/db.ts';
import { createPostgresStorage, migrations, openPostgresStorage, type PostgresStorage } from '../src/index.ts';
import { quoteIdent } from '../src/migrate.ts';
import { storageContract } from './contract.ts';
import { loadContext } from './fixtures.ts';
import { type LiveDb, startLiveDb } from './live-db.ts';

const LIVE = Boolean(process.env.LIVE);
const db: { live: LiveDb | null } = { live: null };
const schemas = new Set<string>();

const newSchema = () => {
  const s = `v2c_live_${randomBytes(4).toString('hex')}`;
  schemas.add(s);
  return s;
};

function ctxFor(env: Env): Ctx {
  return createContext({ runtime: 'node', env, log: { debug() {}, info() {}, warn() {}, error: (m, d) => console.error(m, d ?? '') } });
}

/** One call to the keyless OVH bge-m3 endpoint, waiting out 429s as Retry-After asks (up to about two minutes). */
async function embedLive(input: string[]): Promise<number[][]> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input }),
    });
    if (res.status === 429) {
      const wait = Math.min(30, Number(res.headers.get('retry-after')) || 5 * (attempt + 1));
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`OVH HTTP ${res.status}`);
    const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return body.data.sort((x, y) => x.index - y.index).map((d) => d.embedding);
  }
  throw new Error('OVH kept answering 429');
}

async function rawDb(url: string): Promise<Db> {
  return connect({ url, driver: 'postgres', poolMax: 2 }, ctxFor({}));
}

describe.skipIf(!LIVE)('storage-postgres live', () => {
  beforeAll(async () => {
    db.live = await startLiveDb();
    if (!db.live) console.error('[storage-postgres live] No DATABASE_URL and no Docker: live Postgres tests skipped, nothing verified on a server.');
    else console.error(`[storage-postgres live] using ${db.live.source}${db.live.neon ? ' with Neon HTTP' : ''}`);
  }, 180_000);

  afterAll(async () => {
    if (db.live && schemas.size > 0) {
      const raw = await rawDb(db.live.url);
      for (const s of schemas) await raw.query(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE`);
      await raw.close();
    }
    await db.live?.stop();
  }, 120_000);

  describe('postgres.js driver', () => {
    storageContract('PostgresStorage on a live server (postgres.js)', async () => {
      if (!db.live) return null;
      const storage = await openPostgresStorage(ctxFor({ DATABASE_URL: db.live.url, VID2CONTEXT_PG_SCHEMA: newSchema() }));
      return { storage, done: () => storage.close() };
    });

    it('is the backend the generated Node registry opens when DATABASE_URL is set', async () => {
      if (!db.live) return;
      const { createRegistry } = await import('@vid2context/registry/node');
      const registry = createRegistry();
      const storage = await registry.openStorage(ctxFor({ DATABASE_URL: db.live.url, VID2CONTEXT_PG_SCHEMA: newSchema() }));
      expect(storage?.backend).toBe('postgres');
      await (storage as PostgresStorage).close();
      expect(registry.storages().find((s) => s.id === 'storage-postgres')?.isEnabled({})).toBe(false);
    });

    it('serialises concurrent first starts with the advisory lock', async () => {
      if (!db.live) return;
      const url = db.live.url;
      for (let round = 0; round < 3; round++) {
        const schema = newSchema();
        const conns = await Promise.all([rawDb(url), rawDb(url), rawDb(url), rawDb(url)]);
        const results = await Promise.all(conns.map((c) => createPostgresStorage({ db: c, schema })));
        const applied = results.map((r) => r.migrations.applied);
        // Exactly one instance applied everything; the others found it done.
        expect(applied.filter((a) => a.length === migrations.length)).toHaveLength(1);
        expect(applied.filter((a) => a.length === 0)).toHaveLength(conns.length - 1);
        const rows = await conns[0]?.query<{ version: number }>(`SELECT version FROM ${quoteIdent(schema)}.schema_migrations ORDER BY version`);
        expect(rows?.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
        await Promise.all(conns.map((c) => c.close()));
      }
    });

    it('two pools started at once through openPostgresStorage both work', async () => {
      if (!db.live) return;
      const schema = newSchema();
      const [a, b] = await Promise.all([
        openPostgresStorage(ctxFor({ DATABASE_URL: db.live.url, VID2CONTEXT_PG_SCHEMA: schema, VID2CONTEXT_PG_POOL_MAX: '2' })),
        openPostgresStorage(ctxFor({ DATABASE_URL: db.live.url, VID2CONTEXT_PG_SCHEMA: schema, VID2CONTEXT_PG_POOL_MAX: '3', VID2CONTEXT_TENANT: 't2' })),
      ]);
      await a.kvSet('config:x', 1);
      expect(await b.kvGet('config:x')).toBeNull();
      expect(await a.kvGet('config:x')).toBe(1);
      await Promise.all([a.close(), b.close()]);
    });

    it('reports a wrong password as auth without leaking it', async () => {
      if (!db.live || db.live.source !== 'docker') return;
      const bad = db.live.url.replace(/:([^:@/]+)@/, ':wrong-password-123@');
      const err = await openPostgresStorage(ctxFor({ DATABASE_URL: bad, VID2CONTEXT_PG_SCHEMA: newSchema() })).then(
        () => null,
        (e: unknown) => e as { code: string; message: string; hint: string },
      );
      expect(err?.code).toBe('auth');
      expect(err?.hint).toContain('DATABASE_URL');
      expect(err?.message).not.toContain('wrong-password-123');
    });

    it('answers vector queries from the HNSW index on a real server', async (t) => {
      if (!db.live) t.skip();
      const live = db.live as LiveDb;
      // Embed every segment of the real G-Wagon transcript with the keyless OVH bge-m3 endpoint.
      const gwagon = loadContext('youtube-cCPsdFdlshc.json');
      const texts = gwagon.transcript.segments.map((s) => s.text);
      const vectors: number[][] = [];
      try {
        for (let i = 0; i < texts.length; i += 32) vectors.push(...(await embedLive(texts.slice(i, i + 32))));
      } catch (err) {
        console.error(`[storage-postgres live] OVH embeddings unavailable, HNSW plan not checked: ${(err as Error).message}`);
        t.skip();
      }
      const schema = newSchema();
      const storage = await openPostgresStorage(ctxFor({ DATABASE_URL: live.url, VID2CONTEXT_PG_SCHEMA: schema, VID2CONTEXT_TENANT: 'plan' }));
      const model = 'embed/ovh/bge-m3';
      await storage.upsertVectors(
        gwagon.transcript.segments.map((s, i) => ({
          id: `${gwagon.metadata.ref.id}#${s.startSec}`,
          videoId: gwagon.metadata.ref.id,
          startSec: s.startSec,
          endSec: s.endSec,
          text: s.text,
          model,
          vector: vectors[i] as number[],
        })),
      );
      const q = vectors[texts.findIndex((t) => /transmission/i.test(t))] as number[];
      const hits = await storage.queryVectors({ model, vector: q, limit: 5 });
      expect(hits).toHaveLength(5);
      expect(hits[0]?.text).toMatch(/transmission/i);

      const plan = await storage.vectorQuerySql({ model, vector: q, limit: 5 });
      const raw = await rawDb(live.url);
      const statements = plan?.statements ?? [];
      const select = statements.at(-1);
      const out = await raw.batch([
        { text: `ANALYZE ${quoteIdent(schema)}.vectors` },
        ...statements.slice(0, -1),
        { text: `EXPLAIN (COSTS OFF) ${select?.text}`, params: select?.params },
      ]);
      const text = (out.at(-1) ?? []).map((r) => String(r['QUERY PLAN'])).join('\n');
      console.error(`[storage-postgres live] vector query plan:\n${text.replace(/'\[[^\]]+\]'/g, "'[...1024 floats...]'")}`);
      expect(text).toMatch(/Index Scan using vectors_hnsw_[0-9a-f]{16}/);
      await raw.close();
      await storage.close();
    }, 180_000);
  });

  describe('Neon HTTP driver', () => {
    const neonEnv = (): Env => {
      const neon = db.live?.neon;
      if (!neon) throw new Error('no Neon endpoint');
      return {
        DATABASE_URL: neon.url,
        VID2CONTEXT_PG_DRIVER: 'neon-http',
        VID2CONTEXT_PG_SCHEMA: newSchema(),
        ...(neon.endpoint ? { VID2CONTEXT_PG_NEON_FETCH_ENDPOINT: neon.endpoint } : {}),
      };
    };

    storageContract('PostgresStorage over Neon HTTP', async () => {
      if (!db.live?.neon) return null;
      const storage = await openPostgresStorage(ctxFor(neonEnv()));
      return { storage, done: () => storage.close() };
    });

    it('runs KV and vectors over Neon HTTP', async () => {
      if (!db.live?.neon) return;
      const storage = await openPostgresStorage(ctxFor(neonEnv()));
      await storage.kvSet('jobs:neon', { ok: true }, { ttlSec: 60 });
      expect(await storage.kvGet('jobs:neon')).toEqual({ ok: true });
      expect((await storage.kvList('jobs:')).keys).toEqual(['jobs:neon']);
      await storage.upsertVectors([
        { id: 'a', videoId: 'v', startSec: 0, endSec: 1, text: 'a', model: 'm3', vector: [1, 0, 0] },
        { id: 'b', videoId: 'v', startSec: 1, endSec: 2, text: 'b', model: 'm3', vector: [0, 1, 0] },
      ]);
      const hits = await storage.queryVectors({ model: 'm3', vector: [0.9, 0.1, 0] });
      expect(hits.map((h) => h.id)).toEqual(['a', 'b']);
      expect(hits[0]?.score).toBeCloseTo(0.9939, 3);
      await storage.close();
    });
  });
});
