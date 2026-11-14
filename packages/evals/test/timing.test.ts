import { describe, expect, it } from 'vitest';
import { timedWords, timingError } from '../src/metrics/timing.ts';
import { zooAutoPlain, zooAutoPunct, zooCreator } from './helpers.ts';

describe('timestamp alignment error on real segment timings', () => {
  it('interpolates word starts inside each segment', () => {
    const words = timedWords(zooCreator());
    expect(words[0]).toEqual({ word: 'all', startSec: 1.2 });
    // "All right, so here we are, in front of the elephants" spans 1.2 to 3.36 s over 11 words.
    expect(words[1]?.startSec).toBeCloseTo(1.2 + 2.16 / 11, 6);
    expect(words.every((w, i) => i === 0 || w.startSec >= (words[i - 1] as { startSec: number }).startSec)).toBe(true);
  });

  it('is 0 for a transcript against itself', () => {
    const t = timingError(zooCreator(), zooCreator());
    expect(t.medianSec).toBe(0);
    expect(t.p90Sec).toBe(0);
    expect(t.matched).toBe(38);
  });

  it('measures the offset between creator captions and auto-captions of the same audio', () => {
    const t = timingError(zooCreator(), zooAutoPlain());
    expect(t.matched).toBeGreaterThan(25);
    expect(t.medianSec).toBeGreaterThan(0);
    expect(t.medianSec).toBeLessThan(2);
    expect(t.p90Sec).toBeGreaterThanOrEqual(t.medianSec as number);
    expect(t.maxSec).toBeGreaterThanOrEqual(t.p90Sec as number);
    const other = timingError(zooCreator(), zooAutoPunct());
    expect(other.medianSec).toBeLessThan(2);
  });

  it('reports no matches when nothing aligns', () => {
    expect(timingError(zooCreator(), [])).toEqual({ matched: 0 });
  });
});
