import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { MemoryStorage, Registry, type Storage } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import storageSqlite, { databasePath, parseSearch, SCHEMA_VERSION, SqliteStorage, toMatchExpression } from '../src/index.ts';
import { fixtureContext, storageContract } from './contract.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2c-sqlite-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const closeSqlite = async (s: Storage) => (s as SqliteStorage).close();

// The contract runs on the reference backend too, so it cannot drift from MemoryStorage behaviour.
storageContract(
  'MemoryStorage (reference)',
  async () => new MemoryStorage(),
  async () => {},
);
storageContract('SQLite :memory:', async () => new SqliteStorage({ path: ':memory:' }), closeSqlite);
storageContract('SQLite file', async () => new SqliteStorage({ path: join(tempDir(), 'library.db') }), closeSqlite);
storageContract('SQLite LIKE fallback', async () => new SqliteStorage({ path: ':memory:', fts: false }), closeSqlite);

describe('parseSearch and toMatchExpression', () => {
  it('quotes words, keeps phrases and trailing prefixes', () => {
    expect(toMatchExpression(parseSearch('legendary V8'))).toBe('"legendary" OR "V8"');
    expect(toMatchExpression(parseSearch('"Land Cruiser" killer'))).toBe('"Land Cruiser" OR "killer"');
    expect(toMatchExpression(parseSearch('reliab*'))).toBe('"reliab"*');
    expect(toMatchExpression(parseSearch('"Land Cru"*'))).toBe('"Land Cru"*');
    expect(toMatchExpression(parseSearch('G-Wagon'))).toBe('"G-Wagon"');
  });

  it('drops operators, bare punctuation and unbalanced quotes', () => {
    expect(parseSearch('"')).toEqual([]);
    expect(parseSearch('*')).toEqual([]);
    expect(parseSearch('-')).toEqual([]);
    expect(parseSearch('OR')).toEqual([]);
    expect(parseSearch('NEAR(')).toEqual([]);
    expect(toMatchExpression(parseSearch('engine OR "reliable'))).toBe('"engine" OR "reliable"');
    expect(toMatchExpression(parseSearch('-killer +motor title:engine (v8)'))).toBe(
      '"killer" OR "motor" OR "title" OR "engine" OR "v8"',
    );
    expect(toMatchExpression(parseSearch('NEAR(engine v8, 3)'))).toBe('"engine" OR "v8" OR "3"');
  });
});

describe('search on real transcripts (FTS5)', () => {
  const zoo = fixtureContext('youtube-jNQXAC9IVRw');
  const gwagon = fixtureContext('youtube-cCPsdFdlshc');
  const storage = new SqliteStorage({ path: ':memory:' });
  const ready = Promise.all([storage.putContext(zoo), storage.putContext(gwagon)]);
  afterAll(() => storage.close());

  it('uses FTS5 in this Node build', () => {
    expect(storage.searchMode).toBe('fts5');
  });

  it('ranks the segment with both words of a two-word query first', async () => {
    await ready;
    const hits = await storage.search({ text: 'legendary V8', limit: 10 });
    expect(hits[0]).toMatchObject({ startSec: 71.119, text: 'legendary m113 V8 this was Mercedes big' });
    // Every other hit has only one of the words, so it scores lower.
    expect(hits.length).toBeGreaterThan(5);
    for (const h of hits.slice(1)) expect(h.score).toBeLessThan(hits[0]?.score ?? 0);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]?.score).toBeGreaterThanOrEqual(hits[i]?.score ?? 0);
    expect(hits.every((h) => h.score > 0 && h.score < 1)).toBe(true);
  });

  it('matches exact phrases only where the words are adjacent', async () => {
    await ready;
    const phrase = await storage.search({ text: '"Land Cruiser"' });
    expect(phrase.map((h) => h.startSec)).toEqual([80.04]);
    const words = await storage.search({ text: 'Land Cruiser', limit: 50 });
    expect(words.map((h) => h.startSec)).toEqual(expect.arrayContaining([80.04, 82.24, 83.88]));
  });

  it('expands trailing * as a prefix and matches whole tokens otherwise', async () => {
    await ready;
    expect(await storage.search({ text: 'reliab' })).toEqual([]);
    const prefix = await storage.search({ text: 'reliab*', limit: 50 });
    expect(prefix.length).toBeGreaterThanOrEqual(7);
    expect(prefix.every((h) => /reliab/i.test(h.text))).toBe(true);
  });

  it('folds case and diacritics', async () => {
    await ready;
    const hits = await storage.search({ text: 'ÉLÉPHANTS' });
    expect(hits.map((h) => h.videoId)).toEqual([zoo.metadata.ref.id]);
  });

  it('never throws on hostile input', async () => {
    await ready;
    const inputs = [
      '"',
      'NEAR(',
      '*',
      '-',
      'OR',
      'AND NOT',
      '"unbalanced',
      ')(',
      '^engine',
      'text:engine',
      '{a b}',
      "'; DROP TABLE videos; --",
      'NEAR(engine v8',
      '""',
      '"*"',
      '**v8',
      'engine OR',
      '\u0000',
      'e"n"g',
    ];
    for (const text of inputs) {
      const hits = await storage.search({ text });
      expect(Array.isArray(hits)).toBe(true);
    }
    expect((await storage.listContexts()).items).toHaveLength(2);
  });
});

describe('KvStore', () => {
  it('stores JSON values and expires them after their TTL', async () => {
    const s = new SqliteStorage({ path: ':memory:' });
    await s.kvSet('jobs/1', { state: 'done', n: 3 });
    expect(await s.kvGet('jobs/1')).toEqual({ state: 'done', n: 3 });
    await s.kvSet('tmp/a', 'short', { ttlSec: 0.05 });
    expect(await s.kvGet('tmp/a')).toBe('short');
    await new Promise((r) => setTimeout(r, 80));
    expect(await s.kvGet('tmp/a')).toBeNull();
    expect((await s.kvList('tmp/')).keys).toEqual([]);
    await s.kvDelete('jobs/1');
    expect(await s.kvGet('jobs/1')).toBeNull();
    s.close();
  });

  it('lists live keys by prefix in lexical order with cursors', async () => {
    const s = new SqliteStorage({ path: ':memory:' });
    for (const k of ['watch/c', 'watch/a', 'watch/b', 'watch/d', 'watchlist', 'other/a']) await s.kvSet(k, k);
    await s.kvSet('watch/e', 'gone', { ttlSec: 0.01 });
    await new Promise((r) => setTimeout(r, 30));
    const p1 = await s.kvList('watch/', { limit: 2 });
    expect(p1).toEqual({ keys: ['watch/a', 'watch/b'], cursor: 'watch/b' });
    const p2 = await s.kvList('watch/', { limit: 2, cursor: p1.cursor });
    // Like MemoryKv: the last page carries no cursor.
    expect(p2).toEqual({ keys: ['watch/c', 'watch/d'] });
    expect((await s.kvList('watch')).keys).toEqual(['watch/a', 'watch/b', 'watch/c', 'watch/d', 'watchlist']);
    expect((await s.kvList('')).keys).toHaveLength(6);
    // Prefixes with LIKE and GLOB wildcards are taken literally.
    await s.kvSet('a%_*b', 1);
    expect((await s.kvList('a%_*')).keys).toEqual(['a%_*b']);
    s.close();
  });
});

describe('VectorStore with real bge-m3 embeddings', () => {
  // Recorded from the keyless OVH AI Endpoints bge-m3 model (test/fixtures/README.md).
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/ovh-bge-m3-embeddings.json', import.meta.url), 'utf8')) as {
    data: { index: number; embedding: number[] }[];
  };
  const inputs = JSON.parse(readFileSync(new URL('./fixtures/ovh-bge-m3-embeddings.request.json', import.meta.url), 'utf8')) as {
    input: string[];
  };
  const vec = (i: number) => recorded.data.find((d) => d.index === i)?.embedding ?? [];
  // Inputs 0-1 are G-Wagon segments, 2-3 zoo segments, 4 is the query.
  const records = [0, 1, 2, 3].map((i) => ({
    id: `${i < 2 ? 'youtube:cCPsdFdlshc' : 'youtube:jNQXAC9IVRw'}#${i}`,
    videoId: i < 2 ? 'youtube:cCPsdFdlshc' : 'youtube:jNQXAC9IVRw',
    startSec: i,
    endSec: i + 1,
    text: inputs.input[i] as string,
    model: 'bge-m3',
    vector: vec(i),
  }));
  const query = vec(4);

  it('returns hits in cosine order, filtered by model and videos', async () => {
    const s = new SqliteStorage({ path: ':memory:' });
    await s.upsertVectors(records);
    await s.upsertVectors([{ ...records[2], id: 'other-model', model: 'other', vector: query } as (typeof records)[number]]);
    const hits = await s.queryVectors({ vector: query, model: 'bge-m3', limit: 10 });
    expect(hits).toHaveLength(4);
    expect(hits[0]?.videoId).toBe('youtube:cCPsdFdlshc');
    expect(hits[0]?.text).toBe(inputs.input[0]);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]?.score).toBeGreaterThanOrEqual(hits[i]?.score ?? 0);
    // G-Wagon segments are closer to an engine question than zoo segments.
    expect(new Set(hits.slice(0, 2).map((h) => h.videoId))).toEqual(new Set(['youtube:cCPsdFdlshc']));
    expect(hits.every((h) => h.score > -1 && h.score < 1)).toBe(true);
    expect(hits.some((h) => h.id === 'other-model')).toBe(false);

    const zooOnly = await s.queryVectors({ vector: query, model: 'bge-m3', videoIds: ['youtube:jNQXAC9IVRw'] });
    expect(zooOnly.map((h) => h.videoId)).toEqual(['youtube:jNQXAC9IVRw', 'youtube:jNQXAC9IVRw']);
    // Float32 storage keeps the similarity to float precision.
    const self = await s.queryVectors({ vector: vec(0), model: 'bge-m3', limit: 1 });
    expect(self[0]?.score).toBeCloseTo(1, 5);
    s.close();
  });

  it('upserts by model and id, and deletes by video', async () => {
    const s = new SqliteStorage({ path: ':memory:' });
    await s.upsertVectors(records);
    await s.upsertVectors([{ ...(records[0] as (typeof records)[number]), text: 'replaced' }]);
    await s.upsertVectors([{ ...(records[0] as (typeof records)[number]), model: 'other' }]);
    expect(
      (await s.queryVectors({ vector: query, model: 'bge-m3', limit: 10 })).filter((h) => h.text === 'replaced'),
    ).toHaveLength(1);
    await s.deleteVectors({ videoId: 'youtube:cCPsdFdlshc', model: 'bge-m3' });
    expect((await s.queryVectors({ vector: query, model: 'bge-m3' })).map((h) => h.videoId)).toEqual([
      'youtube:jNQXAC9IVRw',
      'youtube:jNQXAC9IVRw',
    ]);
    expect(await s.queryVectors({ vector: query, model: 'other' })).toHaveLength(1);
    await s.deleteVectors({ videoId: 'youtube:cCPsdFdlshc' });
    expect(await s.queryVectors({ vector: query, model: 'other' })).toHaveLength(0);
    s.close();
  });
});

describe('database file', () => {
  it('migrates an empty file and reopens it at the current version without losing data', async () => {
    const path = join(tempDir(), 'nested', 'dir', 'library.db');
    const a = new SqliteStorage({ path });
    expect(a.schemaVersion).toBe(SCHEMA_VERSION);
    expect(existsSync(path)).toBe(true);
    await a.putContext(fixtureContext('youtube-jNQXAC9IVRw'));
    await a.kvSet('k', 1);
    a.close();

    const b = new SqliteStorage({ path });
    expect(b.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await b.listContexts()).items.map((s) => s.id)).toEqual(['youtube:jNQXAC9IVRw']);
    expect((await b.search({ text: 'trunks' })).map((h) => h.startSec)).toEqual([7.974]);
    expect(await b.kvGet('k')).toBe(1);
    b.close();

    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    raw.close();
  });

  it('refuses a file from a newer schema with a hint', () => {
    const path = join(tempDir(), 'future.db');
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => new SqliteStorage({ path })).toThrowError(
      expect.objectContaining({ code: 'unavailable', hint: expect.any(String) }),
    );
  });

  it('rebuilds the FTS index when it is missing', async () => {
    const path = join(tempDir(), 'library.db');
    const a = new SqliteStorage({ path });
    await a.putContext(fixtureContext('youtube-jNQXAC9IVRw'));
    a.close();
    // Remove the derived index, as a build without FTS5 (or a damaged index) would leave it.
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER segments_ai; DROP TRIGGER segments_ad; DROP TRIGGER segments_au; DROP TABLE segments_fts;');
    raw.close();
    const b = new SqliteStorage({ path });
    expect((await b.search({ text: 'elephants' })).map((h) => h.startSec)).toEqual([1.2]);
    b.close();
  });

  it('rejects an invalid list cursor with bad-request', async () => {
    const s = new SqliteStorage({ path: ':memory:' });
    await expect(s.listContexts({ cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'bad-request' });
    s.close();
  });
});

describe('concurrency', () => {
  it('interleaves writes and reads on two connections to one file', async () => {
    const path = join(tempDir(), 'library.db');
    const a = new SqliteStorage({ path });
    const b = new SqliteStorage({ path });
    const zoo = fixtureContext('youtube-jNQXAC9IVRw');
    const gwagon = fixtureContext('youtube-cCPsdFdlshc');
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const [w, r] = i % 2 ? [a, b] : [b, a];
        await w.putContext(i % 3 ? zoo : gwagon);
        await w.kvSet(`n/${String(i).padStart(2, '0')}`, i);
        expect((await r.search({ text: 'cool', limit: 1 })).length).toBeLessThanOrEqual(1);
        await r.listContexts();
      }),
    );
    expect((await a.kvList('n/')).keys).toHaveLength(20);
    expect((await b.listContexts()).items).toHaveLength(2);
    expect(await b.search({ text: '"Land Cruiser"' })).toHaveLength(1);
    a.close();
    b.close();
  });

  it('waits out a writer in another thread instead of failing with SQLITE_BUSY', async () => {
    const path = join(tempDir(), 'library.db');
    const main = new SqliteStorage({ path });
    // A second thread holds write transactions on the same file for 50 ms at a time.
    const worker = new Worker(
      `const { DatabaseSync } = require('node:sqlite');
       const { parentPort, workerData } = require('node:worker_threads');
       const db = new DatabaseSync(workerData);
       db.exec('PRAGMA busy_timeout = 5000');
       const stop = Date.now() + 600;
       let n = 0;
       parentPort.postMessage('started');
       while (Date.now() < stop) {
         db.exec('BEGIN IMMEDIATE');
         db.prepare("INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT DO NOTHING").run('worker/' + n++);
         const hold = Date.now() + 50;
         while (Date.now() < hold) {}
         db.exec('COMMIT');
       }
       db.close();
       parentPort.postMessage(n);`,
      { eval: true, workerData: path },
    );
    const done = new Promise<number>((res, rej) => {
      worker.on('message', (m) => {
        if (typeof m === 'number') res(m);
      });
      worker.on('error', rej);
    });
    await new Promise<void>((res) => worker.once('message', () => res()));
    const zoo = fixtureContext('youtube-jNQXAC9IVRw');
    for (let i = 0; i < 10; i++) {
      await main.putContext(zoo);
      await main.kvSet(`main/${i}`, i);
    }
    const written = await done;
    expect(written).toBeGreaterThan(0);
    expect((await main.kvList('worker/', { limit: 1000 })).keys).toHaveLength(written);
    expect((await main.kvList('main/')).keys).toHaveLength(10);
    main.close();
  });
});

describe('provider', () => {
  it('is enabled by default and disabled when another backend is named', () => {
    expect(storageSqlite).toMatchObject({ id: 'storage-sqlite', kind: 'storage', runtimes: ['node'] });
    expect(storageSqlite.isEnabled({})).toBe(true);
    expect(storageSqlite.isEnabled({ VID2CONTEXT_STORAGE: 'sqlite' })).toBe(true);
    expect(storageSqlite.isEnabled({ VID2CONTEXT_STORAGE: 'memory' })).toBe(false);
    expect(storageSqlite.isEnabled({ VID2CONTEXT_STORAGE: 'postgres' })).toBe(false);
  });

  it('resolves the database path from env', () => {
    expect(databasePath({})).toBe(resolve('.vid2context', 'library.db'));
    expect(databasePath({ VID2CONTEXT_HOME: '/data/v2c' })).toBe('/data/v2c/library.db');
    expect(databasePath({ VID2CONTEXT_HOME: '/data/v2c', VID2CONTEXT_DB: '/srv/lib.db' })).toBe('/srv/lib.db');
    expect(databasePath({ VID2CONTEXT_DB: ':memory:' })).toBe(':memory:');
  });

  it('is what registry.openStorage returns, unless VID2CONTEXT_STORAGE=memory', async () => {
    const registry = new Registry([storageSqlite], 'node');
    const dir = tempDir();
    const s = await registry.openStorage(testContext({ env: { VID2CONTEXT_HOME: dir } }));
    expect(s?.backend).toBe('sqlite');
    expect((s as SqliteStorage).path).toBe(join(dir, 'library.db'));
    (s as SqliteStorage).close();
    expect(await registry.openStorage(testContext({ env: { VID2CONTEXT_STORAGE: 'memory' } }))).toBeNull();
  });

  it('serves a saved context back across connections, the way the pipeline cache reads it', async () => {
    const env = { VID2CONTEXT_DB: join(tempDir(), 'library.db') };
    const zoo = fixtureContext('youtube-jNQXAC9IVRw');
    const first = (await storageSqlite.create(testContext({ env }))) as SqliteStorage;
    await first.putContext(zoo);
    first.close();
    const second = (await storageSqlite.create(testContext({ env }))) as SqliteStorage;
    expect(await second.getContext('youtube:jNQXAC9IVRw')).toEqual(zoo);
    second.close();
  });
});
