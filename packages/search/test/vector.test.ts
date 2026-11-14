/**
 * The vector side with real recorded OVH embeddings: hybrid hits for
 * paraphrases, idempotent indexing, vectors and manifest kept in a storage
 * backend that implements VectorStore and KvStore, re-indexing when the
 * embedding model changes, and the keyword fallbacks when embedding fails.
 */
import { clearCooldowns, type EmbedRung } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { chunkTranscript } from '../src/chunk.ts';
import { createSearchEngine } from '../src/engine.ts';
import {
  type EmbedFixture,
  embedProvider,
  embedRoute,
  GWAGON,
  loadContext,
  loadEmbedFixture,
  MemoryLibrary,
  OVH_EMBED_URL,
  ovhEmbedRung,
  registryWith,
  SECOND_FIXTURE,
  SECOND_MODEL,
  SECOND_MODEL_QUERY,
  ZOO,
} from './helpers.ts';

beforeEach(() => clearCooldowns());

const gwagon = loadContext(GWAGON);
const zoo = loadContext(ZOO);
const Z = zoo.metadata.ref.id;
const fixture = loadEmbedFixture();
const registry = registryWith([embedProvider([ovhEmbedRung()])]);
const embedCalls = (calls: { url: string }[]) => calls.filter((c) => c.url === OVH_EMBED_URL).length;

describe('hybrid search with real embeddings', () => {
  it('finds a paraphrase through the vector side and reports the pinned model', async () => {
    const fetch = replayFetch([embedRoute(fixture)]);
    const engine = createSearchEngine({ registry, ctx: testContext({ fetch }) });
    expect(engine.embedModel()).toBe('ovh/bge-m3');
    const indexed = await engine.index(gwagon);
    expect(indexed).toMatchObject({ vector: 'indexed', model: 'ovh/bge-m3' });
    expect(indexed.attempts.every((a) => a.id === 'embed/ovh/bge-m3' && a.outcome === 'ok')).toBe(true);
    await engine.index(zoo);

    const out = await engine.search({ query: 'does the engine use a cam chain or a belt', limit: 5 });
    expect(out.meta).toMatchObject({
      vector: 'ok',
      model: 'ovh/bge-m3',
      vectorCoverage: { videos: 2, withVectors: 2 },
      keyword: { ran: true, backend: 'bm25' },
    });
    const hit = out.hits.find((h) => h.startSec <= 92.6 && h.endSec >= 95);
    expect(hit, 'the timing chain passage is in the top 5').toBeTruthy();
    expect(hit?.sources).toContain('vector');

    const zooHit = await engine.search({ query: 'animals with long noses', limit: 1, mode: 'vector' });
    expect(zooHit.hits[0]?.videoId).toBe(Z);
    expect(zooHit.hits[0]?.sources).toEqual(['vector']);
    expect(zooHit.meta.keyword.ran).toBe(false);
  });

  it('reuses vectors for an unchanged transcript instead of embedding again', async () => {
    const fetch = replayFetch([embedRoute(fixture)]);
    const engine = createSearchEngine({ registry, ctx: testContext({ fetch }) });
    await engine.index(zoo);
    const after = embedCalls(fetch.calls);
    const again = await engine.index(zoo);
    expect(again).toMatchObject({ vector: 'reused', model: 'ovh/bge-m3' });
    expect(embedCalls(fetch.calls)).toBe(after);
  });

  it('keeps vectors and the manifest in a storage backend, so a new engine reuses them', async () => {
    const library = new MemoryLibrary();
    await library.putContext(zoo);
    const first = replayFetch([embedRoute(fixture)]);
    const a = createSearchEngine({ registry, storage: library, ctx: testContext({ fetch: first }) });
    expect(a.stats().vectors).toBe('storage');
    const res = await a.search({ query: 'animals with long noses' });
    expect(res.hits[0]?.videoId).toBe(Z);
    expect(library.upsertCalls).toBe(1);

    // A second engine (a restarted server) over the same library embeds only the query.
    const second = replayFetch([embedRoute(fixture)]);
    const b = createSearchEngine({ registry, storage: library, ctx: testContext({ fetch: second }) });
    const again = await b.search({ query: 'animals with long noses' });
    expect(again.hits[0]?.videoId).toBe(Z);
    expect(again.meta.vector).toBe('ok');
    expect(library.upsertCalls).toBe(1);
    expect(embedCalls(second.calls)).toBe(1);
  });

  it('re-indexes with the new model when the embedding model changes, and says so', async () => {
    const second = loadEmbedFixture(SECOND_FIXTURE);
    // A free-tier rung outranks the keyless one once its (test) key is set, as when a user adds a key.
    const gemma: EmbedRung = { ...ovhEmbedRung(SECOND_MODEL), tier: 'free', requires: ['SEARCH_TEST_SECOND_MODEL'] };
    const reg = registryWith([embedProvider([ovhEmbedRung(), gemma])]);
    const fetch = replayFetch([embedRoute(fixture, second)]);
    const library = new MemoryLibrary();
    await library.putContext(zoo);
    const engine = createSearchEngine({ registry: reg, storage: library, ctx: testContext({ fetch }) });

    const before = await engine.search({ query: SECOND_MODEL_QUERY });
    expect(before.meta.model).toBe('ovh/bge-m3');

    const withKey = testContext({ fetch, env: { SEARCH_TEST_SECOND_MODEL: '1' } });
    expect(engine.embedModel(withKey)).toBe(`ovh/${SECOND_MODEL}`);
    const after = await engine.search({ query: SECOND_MODEL_QUERY }, { ctx: withKey });
    expect(after.meta.model).toBe(`ovh/${SECOND_MODEL}`);
    expect(after.meta.reindexed).toEqual([{ videoId: Z, from: 'ovh/bge-m3', to: `ovh/${SECOND_MODEL}` }]);
    expect(after.meta.vector).toBe('ok');
    expect(after.hits[0]?.videoId).toBe(Z);
    expect(after.hits[0]?.sources).toContain('vector');
    // Old-model vectors are gone: one model per index.
    const old = await library.queryVectors({ vector: new Array(1024).fill(0.01), model: 'ovh/bge-m3' });
    expect(old).toEqual([]);
  });

  it('pins a model by name and reports a pinned model that is not enabled', async () => {
    const pinned = createSearchEngine({ registry, ctx: testContext(), embedModel: 'bge-m3' });
    expect(pinned.embedModel()).toBe('ovh/bge-m3');
    const missing = createSearchEngine({ registry, ctx: testContext(), embedModel: 'nomic-embed-text' });
    expect(missing.embedModel()).toBeNull();
    const res = await missing.index(zoo);
    expect(res).toMatchObject({
      vector: 'disabled',
      reason: 'The pinned embedding model "nomic-embed-text" has no enabled rung.',
    });
  });
});

describe('fallbacks when embedding fails', () => {
  it('returns keyword results and says the query could not be embedded', async () => {
    const engine = createSearchEngine({ registry, ctx: testContext({ fetch: replayFetch([embedRoute(fixture)]) }) });
    await engine.index(gwagon);
    // No recording exists for this query, so its embedding request fails like a network error would.
    const out = await engine.search({ query: 'beadlocks wheels' });
    expect(out.meta.vector).toBe('failed');
    expect(out.meta.vectorReason).toMatch(/^The query could not be embedded, results are keyword-only/);
    expect(out.meta.attempts.some((a) => a.stage === 'embed' && a.outcome === 'error')).toBe(true);
    expect(out.hits[0]?.text).toContain('beadlocks');
    expect(out.hits[0]?.sources).toEqual(['keyword']);
  });

  it('reports partial coverage when some videos could not be embedded yet', async () => {
    // Only the zoo chunks and queries are replayable; the G-Wagon chunk requests fail.
    const gwagonTexts = new Set(chunkTranscript(gwagon).map((c) => c.text));
    const zooOnly: EmbedFixture = { ...fixture, calls: fixture.calls.filter((c) => !c.input.some((t) => gwagonTexts.has(t))) };
    const library = new MemoryLibrary();
    await library.putContext(gwagon);
    await library.putContext(zoo);
    const engine = createSearchEngine({
      registry,
      storage: library,
      ctx: testContext({ fetch: replayFetch([embedRoute(zooOnly)]) }),
    });
    const out = await engine.search({ query: 'animals with long noses' });
    expect(out.meta.vector).toBe('partial');
    expect(out.meta.vectorCoverage?.videos).toBe(2);
    expect(out.meta.vectorCoverage?.withVectors).toBeLessThan(2);
    expect(out.meta.vectorReason).toMatch(/have no vectors yet/);
  });
});
