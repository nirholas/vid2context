/**
 * Retrieval quality on the real transcripts: precision@5, MRR and hit@5 for
 * keyword-only, vector-only and hybrid search over the evaluation set in
 * fixtures/queries.json, with query and chunk embeddings replayed from real
 * OVH bge-m3 responses. Prints a table and asserts hybrid is not worse than
 * the better single method.
 *
 * A hit is relevant when its time range overlaps an expected range of the
 * same video. Precision@5 divides by 5 even when fewer hits come back, so
 * queries with one relevant passage cap at 0.2; compare the columns with
 * each other. Two precision figures are reported:
 *
 *   P@5 (raw)       every relevant hit counts, so three overlapping hits on
 *                   the same passage count three times
 *   P@5 (distinct)  each expected passage is credited once, to the first hit
 *                   that covers it; repeats of a passage already shown count
 *                   as not relevant
 *
 * Hybrid merges neighbouring chunks into one range, so a passage both sides
 * found comes back once; raw precision rewards a method for returning the
 * same passage several times, which is why the assertion uses the distinct
 * figure and MRR, and the table shows both.
 */
import { clearCooldowns } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSearchEngine, type SearchEngine } from '../src/engine.ts';
import {
  type EvalQuery,
  embedProvider,
  embedRoute,
  GWAGON,
  loadContext,
  loadEmbedFixture,
  loadQueries,
  ovhEmbedRung,
  registryWith,
  ZOO,
} from './helpers.ts';

type Mode = 'keyword' | 'vector' | 'hybrid';
const MODES: Mode[] = ['keyword', 'vector', 'hybrid'];
const K = 5;

interface Scores {
  p5: number;
  p5distinct: number;
  mrr: number;
  hit5: number;
}

type Hit = { videoId: string; startSec: number; endSec: number };

function score(q: EvalQuery, hits: Hit[]): Scores {
  const top = hits.slice(0, K);
  const covers = (h: Hit, e: EvalQuery['expect'][number]) =>
    e.videoId === h.videoId && h.startSec <= e.endSec && e.startSec <= h.endSec;
  const rel = top.map((h) => q.expect.some((e) => covers(h, e)));
  const credited = new Set<number>();
  let distinct = 0;
  for (const h of top) {
    const i = q.expect.findIndex((e, j) => !credited.has(j) && covers(h, e));
    if (i >= 0) {
      credited.add(i);
      distinct++;
    }
  }
  const first = rel.indexOf(true);
  return {
    p5: rel.filter(Boolean).length / K,
    p5distinct: distinct / K,
    mrr: first < 0 ? 0 : 1 / (first + 1),
    hit5: first < 0 ? 0 : 1,
  };
}

function mean(list: Scores[]): Scores {
  const n = list.length || 1;
  return {
    p5: list.reduce((s, x) => s + x.p5, 0) / n,
    p5distinct: list.reduce((s, x) => s + x.p5distinct, 0) / n,
    mrr: list.reduce((s, x) => s + x.mrr, 0) / n,
    hit5: list.reduce((s, x) => s + x.hit5, 0) / n,
  };
}

const f = (x: number) => x.toFixed(3);

describe('evaluation: keyword vs vector vs hybrid', () => {
  const queries = loadQueries();
  let engine: SearchEngine;
  const results = new Map<Mode, Map<string, Scores>>();

  beforeAll(async () => {
    clearCooldowns();
    const ctx = testContext({ fetch: replayFetch([embedRoute(loadEmbedFixture())]) });
    engine = createSearchEngine({ registry: registryWith([embedProvider([ovhEmbedRung()])]), ctx });
    for (const file of [GWAGON, ZOO]) {
      const res = await engine.index(loadContext(file));
      expect(res.vector).toBe('indexed');
    }
    for (const mode of MODES) {
      const perQuery = new Map<string, Scores>();
      for (const q of queries) {
        const out = await engine.search({ query: q.query, mode, limit: K });
        if (mode !== 'keyword') expect(out.meta.vector, `${q.id} (${mode})`).toBe('ok');
        perQuery.set(q.id, score(q, out.hits));
      }
      results.set(mode, perQuery);
    }
  });

  it('has at least 15 queries covering exact terms, paraphrases and negations', () => {
    expect(queries.length).toBeGreaterThanOrEqual(15);
    expect(new Set(queries.map((q) => q.type))).toEqual(new Set(['exact', 'paraphrase', 'negation']));
  });

  it('prints the table and hybrid is not worse than the better single method', () => {
    const groups: [string, EvalQuery[]][] = [
      ['all', queries],
      ['exact', queries.filter((q) => q.type === 'exact')],
      ['paraphrase', queries.filter((q) => q.type === 'paraphrase')],
      ['negation', queries.filter((q) => q.type === 'negation')],
    ];
    const overall = new Map<Mode, Scores>();
    const rows: string[] = [
      '| Queries | n | Method | P@5 (distinct) | P@5 (raw) | MRR | Hit@5 |',
      '|---|---|---|---|---|---|---|',
    ];
    for (const [name, qs] of groups) {
      for (const mode of MODES) {
        const per = results.get(mode) as Map<string, Scores>;
        const m = mean(qs.map((q) => per.get(q.id) as Scores));
        if (name === 'all') overall.set(mode, m);
        rows.push(`| ${name} | ${qs.length} | ${mode} | ${f(m.p5distinct)} | ${f(m.p5)} | ${f(m.mrr)} | ${f(m.hit5)} |`);
      }
    }
    const misses = MODES.map((mode) => {
      const per = results.get(mode) as Map<string, Scores>;
      const missed = queries.filter((q) => (per.get(q.id) as Scores).hit5 === 0).map((q) => q.id);
      return `${mode} misses (no relevant hit in top 5): ${missed.join(', ') || 'none'}`;
    });
    console.log(`\n${rows.join('\n')}\n\n${misses.join('\n')}\n`);

    const kw = overall.get('keyword') as Scores;
    const vec = overall.get('vector') as Scores;
    const hyb = overall.get('hybrid') as Scores;
    expect(hyb.mrr).toBeGreaterThanOrEqual(Math.max(kw.mrr, vec.mrr));
    expect(hyb.p5distinct).toBeGreaterThanOrEqual(Math.max(kw.p5distinct, vec.p5distinct));
  });
});
