import type { Segment } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { loadSearchDataset } from '../src/dataset.ts';
import { boundaryAgreement } from '../src/metrics/chapters.ts';
import { normalizeWords } from '../src/metrics/normalize.ts';
import { precisionAtK, recallAtK, reciprocalRank, retrievalScore, type TimeRange } from '../src/metrics/retrieval.ts';
import { sharedContext } from './helpers.ts';

const VIDEO = 'youtube:cCPsdFdlshc';

/**
 * The simplest real ranker: 30 s windows of the recorded transcript ranked by
 * how many query words they contain. Its output is real, not invented, and
 * good enough to exercise the metrics.
 */
function keywordRanker(segments: readonly Segment[], query: string): TimeRange[] {
  const q = new Set(normalizeWords(query).filter((w) => w.length > 3));
  const windows: { range: TimeRange; score: number }[] = [];
  for (let start = 0; start < (segments.at(-1)?.endSec ?? 0); start += 30) {
    const words = normalizeWords(
      segments
        .filter((s) => s.startSec >= start && s.startSec < start + 30)
        .map((s) => s.text)
        .join(' '),
    );
    const score = words.filter((w) => q.has(w)).length;
    if (score > 0) windows.push({ range: { videoId: VIDEO, startSec: start, endSec: start + 30 }, score });
  }
  return windows.sort((a, b) => b.score - a.score || a.range.startSec - b.range.startSec).map((w) => w.range);
}

describe('retrieval metrics on search.json with a real keyword ranker', () => {
  const segments = sharedContext('youtube-cCPsdFdlshc.json').transcript.segments;
  const data = loadSearchDataset();
  const judged = data.queries.map((q) => ({ hits: keywordRanker(segments, q.query), expected: q.expected }));

  it('computes precision@k, recall@k and MRR within [0, 1]', () => {
    const s = retrievalScore(judged, 5);
    expect(s.queries).toBe(data.queries.length);
    for (const v of [s.precisionAtK, s.recallAtK, s.mrr]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('finds the M278 discussion for its query at rank 1', () => {
    const q = data.queries.find((x) => x.id === 'm278-engine');
    const hits = keywordRanker(segments, q?.query ?? '');
    expect(reciprocalRank({ hits, expected: q?.expected ?? [] })).toBe(1);
  });

  it('counts each expected range once for recall and each hit once for precision', () => {
    const q = data.queries.find((x) => x.id === 'off-road-build');
    const expected = q?.expected ?? [];
    expect(expected).toHaveLength(3);
    const exact = { hits: expected, expected };
    expect(recallAtK(exact, 3)).toBe(1);
    expect(precisionAtK(exact, 3)).toBe(1);
    expect(recallAtK(exact, 1)).toBeCloseTo(1 / 3, 10);
    expect(reciprocalRank({ hits: [], expected })).toBe(0);
    expect(precisionAtK({ hits: [{ ...expected[0], videoId: 'youtube:other' } as TimeRange], expected }, 1)).toBe(0);
  });
});

describe('chapter boundary agreement', () => {
  const chapters = sharedContext('youtube-jNQXAC9IVRw.json').metadata.chapters.map((c) => c.startSec);

  it('agrees fully with itself, ignoring the boundary at 0', () => {
    const a = boundaryAgreement(chapters, chapters, 1);
    expect(a.reference).toBe(chapters.filter((s) => s > 1).length);
    expect(a.precision).toBe(1);
    expect(a.recall).toBe(1);
  });

  it('matches one-to-one within the tolerance', () => {
    const a = boundaryAgreement([60, 120, 180], [62, 63, 400], 5);
    expect(a.matched).toBe(1);
    expect(a.precision).toBeCloseTo(1 / 3, 10);
    expect(a.recall).toBeCloseTo(1 / 3, 10);
  });

  it('scores 0 when nothing is predicted', () => {
    expect(boundaryAgreement(chapters, [], 1).recall).toBe(0);
  });
});
