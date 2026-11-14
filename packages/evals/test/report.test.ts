import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/report.ts';
import { type EvalResult, summarize } from '../src/results.ts';

const results = (name: string): string => fileURLToPath(new URL(`../results/${name}`, import.meta.url));
const load = (name: string): EvalResult => JSON.parse(readFileSync(results(name), 'utf8')) as EvalResult;

describe('Markdown report from a real result', () => {
  // Produced by `LIVE=1 npm run eval -- --suite search` on 2026-11-14.
  const result = load('2026-11-14-search.json');

  it('renders exactly the report written next to the result', () => {
    expect(renderReport(result)).toBe(readFileSync(results('2026-11-14-search.md'), 'utf8'));
  });

  it('has a header, a summary row per mode and an items table', () => {
    const md = renderReport(result);
    expect(md).toMatch(/^# vid2context eval: search \(2026-11-14\)/);
    expect(md).toContain('15 of 15 items evaluated');
    expect(md).toMatch(/\| search\/keyword \| 15 \| 15 \| 5 \|/);
    expect(md).toContain('## Items');
    expect(md.split('\n').filter((l) => l.startsWith('| ') && l.includes('search/')).length).toBe(2 + result.items.length);
  });

  it('summarizes the per-query scores it was given', () => {
    const rows = summarize(result.items);
    const keyword = rows.find((r) => r.rung === 'search/keyword');
    const own = result.items.filter((i) => i.rung === 'search/keyword');
    const mrr = own.reduce((n, i) => n + (i.retrieval?.reciprocalRank ?? 0), 0) / own.length;
    expect(keyword?.mrr).toBeCloseTo(mrr, 10);
    expect(keyword?.recallAtK).toBeLessThanOrEqual(1);
  });
});
