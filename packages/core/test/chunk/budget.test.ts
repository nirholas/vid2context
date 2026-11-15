import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type BudgetPlan, fitToBudget, transcriptOutline } from '../../src/chunk/index.ts';
import { item as at } from '../../src/chunk/spans.ts';
import { Vid2ContextError } from '../../src/errors.ts';
import type { VideoContext } from '../../src/types.ts';

const load = (f: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/contexts/${f}`, import.meta.url), 'utf8'));
const zoo = load('youtube-jNQXAC9IVRw.json');
const gwagon = load('youtube-cCPsdFdlshc.json');

/** Included and omitted ranges of each video must tile its outline span exactly, with no gaps or overlaps. */
function checkCoverage(contexts: VideoContext[], plan: BudgetPlan): void {
  expect(plan.items.map((i) => i.videoId)).toEqual(contexts.map((c) => c.metadata.ref.id));
  for (const [n, ctx] of contexts.entries()) {
    const item = at(plan.items, n);
    const sections = transcriptOutline(ctx).sections;
    const start = at(sections, 0).startSec;
    const end = sections.at(-1)?.endSec;
    const omitted = plan.omitted.filter((o) => o.videoId === item.videoId);
    if (item.whole) {
      expect(omitted).toEqual([]);
      expect(item.sections).toBeUndefined();
      continue;
    }
    const ranges = [...(item.sections ?? []), ...omitted].sort((a, b) => a.startSec - b.startSec);
    expect(at(ranges, 0).startSec).toBe(start);
    expect(ranges.at(-1)?.endSec).toBe(end);
    for (let i = 1; i < ranges.length; i++) expect(at(ranges, i).startSec).toBe(at(ranges, i - 1).endSec);
    // Included sections are leading: every one comes before every omitted range.
    const lastIncluded = item.sections?.at(-1)?.endSec ?? start;
    for (const o of omitted) expect(o.startSec).toBeGreaterThanOrEqual(lastIncluded);
  }
}

const used = (plan: BudgetPlan, overhead = 0) =>
  plan.items.reduce((sum, item, n) => {
    if (item.whole) return sum + transcriptOutline(at([zoo, gwagon], n)).totalTokens + overhead;
    const t = (item.sections ?? []).reduce((a, s) => a + s.tokens, 0);
    return sum + (item.sections?.length ? t + overhead : 0);
  }, 0);

describe('fitToBudget', () => {
  const contexts = [zoo, gwagon];
  const total = contexts.reduce((a, c) => a + transcriptOutline(c).totalTokens, 0);

  it('never exceeds the budget and accounts for every range, at many budgets', () => {
    for (const budget of [1, 30, 100, 500, 1000, 2500, 4000, total - 1, total, total * 2]) {
      for (const overhead of [0, 25]) {
        const plan = fitToBudget(contexts, budget, { perVideoOverhead: overhead });
        expect(plan.totalTokens, `budget ${budget}`).toBeLessThanOrEqual(budget);
        expect(plan.totalTokens).toBe(used(plan, overhead));
        checkCoverage(contexts, plan);
      }
    }
  });

  it('includes everything whole when it fits', () => {
    const plan = fitToBudget(contexts, total);
    expect(plan.items.every((i) => i.whole)).toBe(true);
    expect(plan.omitted).toEqual([]);
    expect(plan.totalTokens).toBe(total);
  });

  it('keeps small videos whole and fills the rest with leading sections of the long one', () => {
    const plan = fitToBudget(contexts, 3000);
    expect(at(plan.items, 0).whole).toBe(true);
    const g = at(plan.items, 1);
    expect(g.whole).toBe(false);
    const sections = transcriptOutline(gwagon).sections;
    // The first two five-minute sections fit whole, then part of the third.
    expect(g.sections?.slice(0, 2)).toEqual(
      sections.slice(0, 2).map((s) => ({ startSec: s.startSec, endSec: s.endSec, tokens: s.tokens })),
    );
    expect(g.sections?.[2]?.startSec).toBe(at(sections, 2).startSec);
    expect(g.sections?.[2]?.endSec).toBeLessThan(at(sections, 2).endSec);
    // Nearly the whole budget is used.
    expect(plan.totalTokens).toBeGreaterThan(2900);
  });

  it('shares the budget in proportion to length when nothing fits whole', () => {
    // 40 tokens: neither the 51-token zoo video nor the long one fits whole.
    const plan = fitToBudget(contexts, 40);
    expect(plan.items.every((i) => !i.whole)).toBe(true);
    const z = (at(plan.items, 0).sections ?? []).reduce((a, s) => a + s.tokens, 0);
    const g = (at(plan.items, 1).sections ?? []).reduce((a, s) => a + s.tokens, 0);
    expect(g).toBeGreaterThan(z);
    expect(plan.totalTokens).toBeLessThanOrEqual(40);
    checkCoverage(contexts, plan);
  });

  it('lists a video with no room at all as fully omitted', () => {
    const plan = fitToBudget([gwagon, zoo], 60, { perVideoOverhead: 55 });
    expect(plan.items[0]).toEqual({ videoId: 'youtube:cCPsdFdlshc', whole: false, sections: [] });
    expect(plan.omitted[0]).toMatchObject({ videoId: 'youtube:cCPsdFdlshc', startSec: 0 });
    expect(plan.totalTokens).toBeLessThanOrEqual(60);
  });

  it('rejects a non-positive budget', () => {
    expect(() => fitToBudget(contexts, 0)).toThrow(Vid2ContextError);
  });
});
