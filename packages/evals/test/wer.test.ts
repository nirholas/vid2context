import { describe, expect, it } from 'vitest';
import { align, editCounts } from '../src/metrics/align.ts';
import { normalizeWords } from '../src/metrics/normalize.ts';
import { characterErrorRate, pooledRate, wordErrorRate } from '../src/metrics/wer.ts';
import { textOf } from '../src/refs.ts';
import { sharedContext, zooAutoPlain, zooAutoPunct, zooCreator } from './helpers.ts';

describe('word error rate on real creator and auto captions of the same audio', () => {
  const creator = textOf(zooCreator());
  const auto = textOf(zooAutoPlain());

  it('scores identical texts 0', () => {
    expect(wordErrorRate(creator, creator).rate).toBe(0);
    expect(characterErrorRate(creator, creator).rate).toBe(0);
    const gwagon = textOf(sharedContext('youtube-cCPsdFdlshc.json').transcript.segments);
    expect(wordErrorRate(gwagon, gwagon).errors).toBe(0);
  });

  it('puts YouTube auto-captions in a sane range against the creator text', () => {
    const w = wordErrorRate(creator, auto);
    // 38 reference words; the recognizer missed "all right", heard "one of" for "in front of" and "fronts" for "trunks", and repeated "that's".
    expect(w.refLength).toBe(38);
    expect(w.rate).toBeGreaterThan(0.05);
    expect(w.rate).toBeLessThan(0.35);
    const c = characterErrorRate(creator, auto);
    expect(c.rate).toBeGreaterThan(0);
    expect(c.rate).toBeLessThan(w.rate);
  });

  it('counts substitutions, deletions and insertions that add up to the alignment', () => {
    const r = normalizeWords(creator);
    const h = normalizeWords(auto);
    const a = align(r, h);
    expect(a.matches + a.substitutions + a.deletions).toBe(r.length);
    expect(a.matches + a.substitutions + a.insertions).toBe(h.length);
    expect(a.steps).toHaveLength(a.matches + a.substitutions + a.deletions + a.insertions);
    const w = wordErrorRate(creator, auto);
    expect(w.errors).toBe(a.substitutions + a.deletions + a.insertions);
    expect({ s: w.substitutions, d: w.deletions, i: w.insertions }).toEqual({
      s: a.substitutions,
      d: a.deletions,
      i: a.insertions,
    });
    expect(a.steps.filter((s) => s.op === 'ins').map((s) => h[s.hyp as number])).toContain('thats');
  });

  it('gives the same counts with and without a backtrace on a long real transcript', () => {
    const gw = sharedContext('youtube-cCPsdFdlshc.json').transcript.segments;
    const first = normalizeWords(textOf(gw.slice(0, 120)));
    const shifted = normalizeWords(textOf(gw.slice(3, 125)));
    const a = align(first, shifted);
    const { steps: _steps, ...withSteps } = a;
    expect(editCounts(first, shifted)).toEqual(withSteps);
  });

  it('scores punctuation-only differences as 0 after normalization', () => {
    const plain = textOf(zooAutoPunct()).replace(/[.,]/g, '').toLowerCase();
    expect(wordErrorRate(textOf(zooAutoPunct()), plain).rate).toBe(0);
  });

  it('pools items by total errors over total reference words', () => {
    const a = wordErrorRate(creator, auto);
    const b = wordErrorRate(creator, textOf(zooAutoPunct()));
    const pooled = pooledRate([a, b]);
    expect(pooled.refLength).toBe(a.refLength + b.refLength);
    expect(pooled.rate).toBeCloseTo((a.errors + b.errors) / (a.refLength + b.refLength), 10);
  });

  it('handles empty sides', () => {
    expect(wordErrorRate('', '').rate).toBe(0);
    expect(wordErrorRate('[Music]', 'so here we are').rate).toBe(1);
    expect(wordErrorRate(creator, '').deletions).toBe(38);
  });
});
