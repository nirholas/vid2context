/**
 * Retrieval quality on the real transcripts: precision@5, MRR and hit@5 for
 * keyword-only, vector-only and hybrid search over the evaluation set in
 * fixtures/queries.json, with query and chunk embeddings replayed from real
 * OVH bge-m3 responses. Prints a table and asserts hybrid is not worse than
 * the better single method.
 *
 * A hit is relevant when its time range overlaps an expected range of the
 * same video. Precision@5 divides by 5 even when fewer hits come back, so
 * queries with one relevant passage cap at 0.2 (merging neighbouring chunks
 * into one range makes that common); compare the columns with each other.
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
  mrr: number;
  hit5: number;
}

function judge(q: EvalQuery, hits: { videoId: string; startSec: number; endSec: number }[]): boolean[] {
  return hits.map((h) => q.expect.some((e) => e.videoId === h.videoId && h.startSec <= e.endSec && e.startSec <= h.endSec));
}

function score(rel: boolean[]): Scores {
  const top = rel.slice(0, K);
  const first = top.indexOf(true);
  return { p5: top.filter(Boolean).length / K, mrr: first < 0 ? 0 : 1 / (first + 1), hit5: first < 0 ? 0 : 1 };
}

function mean(list: Scores[]): Scores {
  const n = list.length || 1;
  return {
    p5: list.reduce((s, x) => s + x.p5, 0) / n,
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
        perQuery.set(q.id, score(judge(q, out.hits)));
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
    const rows: string[] = [`| Queries | n | Method | Precision@5 | MRR | Hit@5 |`, `|---|---|---|---|---|---|`];
    for (const [name, qs] of groups) {
      for (const mode of MODES) {
        const per = results.get(mode) as Map<string, Scores>;
        const m = mean(qs.map((q) => per.get(q.id) as Scores));
        if (name === 'all') overall.set(mode, m);
        rows.push(`| ${name} | ${qs.length} | ${mode} | ${f(m.p5)} | ${f(m.mrr)} | ${f(m.hit5)} |`);
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
    expect(hyb.p5).toBeGreaterThanOrEqual(Math.max(kw.p5, vec.p5));
  });
});
