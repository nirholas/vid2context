/**
 * The engine with no embedding provider: keyword-only search over the real
 * transcripts, storage sync, filters, collections, query syntax, and the
 * storage full-text path. No network.
 */
import { MemoryStorage, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { createSearchEngine } from '../src/engine.ts';
import { GWAGON, loadContext, registryWith, ZOO } from './helpers.ts';

const gwagon = loadContext(GWAGON);
const zoo = loadContext(ZOO);
const GW = gwagon.metadata.ref.id;
const Z = zoo.metadata.ref.id;

function bare() {
  return createSearchEngine({ registry: registryWith([]), ctx: testContext() });
}

describe('keyword-only engine (no embed rung)', () => {
  it('indexes, reports vector disabled, and finds exact terms with links and highlights', async () => {
    const engine = bare();
    const res = await engine.index(gwagon);
    expect(res).toMatchObject({ videoId: GW, vector: 'disabled', reason: 'No embedding provider is installed.' });
    expect(res.chunks).toBeGreaterThan(25);
    expect(engine.embedModel()).toBeNull();

    const out = await engine.search({ query: 'timing chain', limit: 3 });
    expect(out.meta).toMatchObject({
      mode: 'hybrid',
      vector: 'disabled',
      vectorReason: 'No embedding provider is installed.',
      keyword: { ran: true, backend: 'bm25' },
      rerank: 'off',
      indexed: { videos: 1 },
    });
    const [top] = out.hits;
    expect(top?.sources).toEqual(['keyword']);
    expect(top?.text).toContain('timing Chains');
    expect(top?.snippet).toContain('**timing**');
    expect(top?.url).toBe(`https://www.youtube.com/watch?v=cCPsdFdlshc&t=${Math.floor(top?.startSec ?? 0)}s`);
    expect(top?.title).toBe(gwagon.metadata.title);
    expect(top?.channel).toBe('Alliance Motorworks');
    expect(top && top.startSec <= 92.6 && top.endSec >= 95).toBe(true);
  });

  it('is idempotent per video and removes cleanly', async () => {
    const engine = bare();
    await engine.index(gwagon);
    const before = engine.stats();
    await engine.index(gwagon);
    expect(engine.stats()).toEqual(before);
    await engine.index(zoo);
    expect(engine.stats().videos).toBe(2);
    await engine.remove(GW);
    expect(engine.stats()).toMatchObject({ videos: 1, chunks: 2 });
    expect((await engine.search({ query: 'G550' })).hits).toEqual([]);
  });

  it('enforces phrases and exclusions', async () => {
    const engine = bare();
    await engine.index(gwagon);
    const phrase = await engine.search({ query: '"Land Cruiser killer"' });
    expect(phrase.hits.length).toBeGreaterThan(0);
    for (const h of phrase.hits) expect(h.text).toMatch(/Land\s+Cruiser\s+killer/i);
    expect(phrase.meta.query.phrases).toEqual(['Land Cruiser killer']);

    const all = await engine.search({ query: 'oil', limit: 20 });
    expect(all.hits.some((h) => /cooler/i.test(h.text))).toBe(true);
    const neg = await engine.search({ query: 'oil -cooler', limit: 20 });
    expect(neg.hits.length).toBeGreaterThan(0);
    for (const h of neg.hits) expect(h.text).not.toMatch(/cooler/i);
    expect(neg.meta.query.excluded).toEqual(['cooler']);
  });

  it('merges neighbouring chunks into one time range', async () => {
    const engine = bare();
    await engine.index(gwagon);
    const out = await engine.search({ query: 'naturally aspirated coolers off-road turbo', limit: 10 });
    const ranges = out.hits.map((h) => [h.startSec, h.endSec] as const);
    for (const h of out.hits) expect(h.endSec - h.startSec).toBeLessThanOrEqual(150);
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const [a, b] = [ranges[i], ranges[j]] as [readonly [number, number], readonly [number, number]];
        // Ranges of one video only touch when merging them would pass the 150 s cap.
        if (a[0] <= b[1] + 1 && b[0] <= a[1] + 1) expect(Math.max(a[1], b[1]) - Math.min(a[0], b[0])).toBeGreaterThan(150);
      }
    }
    expect(out.hits.some((h) => h.endSec - h.startSec > 60)).toBe(true);
  });

  it('filters by videoIds, channel, origin and dates', async () => {
    const engine = bare();
    await engine.index(gwagon);
    await engine.index(zoo);
    const q = 'cool';
    const ids = (r: Awaited<ReturnType<typeof engine.search>>) => [...new Set(r.hits.map((h) => h.videoId))].sort();
    expect(ids(await engine.search({ query: q, limit: 20 }))).toEqual([GW, Z].sort());
    expect(ids(await engine.search({ query: q, videoIds: [Z] }))).toEqual([Z]);
    expect(ids(await engine.search({ query: q, channel: 'alliance motorworks', limit: 20 }))).toEqual([GW]);
    expect(ids(await engine.search({ query: q, origin: 'creator-captions' }))).toEqual([Z]);
    expect(ids(await engine.search({ query: q, origin: ['auto-captions', 'stt'], limit: 20 }))).toEqual([GW]);
    // Neither fixture has a publish date, so any date filter excludes both.
    expect((await engine.search({ query: q, publishedAfter: '2000-01-01' })).hits).toEqual([]);
    await expect(engine.search({ query: q, publishedBefore: 'last week' })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('rejects an empty query with a hint', async () => {
    const err = await bare()
      .search({ query: '   ' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err).toMatchObject({ code: 'bad-request', hint: 'Pass some words to search for.' });
  });
});

describe('engine over a storage backend', () => {
  async function library() {
    const storage = new MemoryStorage();
    await storage.putContext(gwagon);
    await storage.putContext(zoo);
    return storage;
  }

  it('syncs saved contexts on search and drops deleted ones', async () => {
    const storage = await library();
    const engine = createSearchEngine({ registry: registryWith([]), storage, ctx: testContext() });
    const first = await engine.search({ query: 'elephants' });
    expect(first.meta.indexed.videos).toBe(2);
    expect(first.hits[0]?.videoId).toBe(Z);
    expect(first.hits[0]?.chapterTitle).toBe('Intro');
    await storage.deleteContext(Z);
    const second = await engine.search({ query: 'elephants' });
    expect(second.meta.indexed.videos).toBe(1);
    expect(second.hits).toEqual([]);
  });

  it('scopes to a collection and reports a missing one', async () => {
    const storage = await library();
    const c = await storage.createCollection({ name: 'zoo trips' });
    await storage.addToCollection(c.id, [Z]);
    const engine = createSearchEngine({ registry: registryWith([]), storage, ctx: testContext() });
    expect((await engine.search({ query: 'elephants', collectionId: c.id })).hits).toHaveLength(1);
    expect((await engine.search({ query: 'G550', collectionId: c.id })).hits).toEqual([]);
    await expect(engine.search({ query: 'G550', collectionId: 'nope' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('uses the storage backend search when asked, mapped onto chunks', async () => {
    const storage = await library();
    const engine = createSearchEngine({ registry: registryWith([]), storage, ctx: testContext(), keyword: 'storage' });
    const out = await engine.search({ query: 'beadlocks', limit: 3 });
    expect(out.meta.keyword.backend).toBe('storage');
    expect(out.hits[0]?.text).toContain('beadlocks');
    expect(out.hits[0]?.sources).toEqual(['keyword']);
    // auto picks BM25 for MemoryStorage, which has no real full-text search.
    expect(createSearchEngine({ registry: registryWith([]), storage, ctx: testContext() }).stats().keyword).toBe('bm25');
  });

  it('needs storage for keyword: storage and for collections', async () => {
    expect(() => createSearchEngine({ registry: registryWith([]), ctx: testContext(), keyword: 'storage' })).toThrow(
      /needs a storage backend/,
    );
    await expect(bare().search({ query: 'x', collectionId: 'c' })).rejects.toMatchObject({ code: 'bad-request' });
  });
});
