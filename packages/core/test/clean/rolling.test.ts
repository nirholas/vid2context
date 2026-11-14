import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSrv3 } from '@vid2context/provider-youtube';
import { describe, expect, it } from 'vitest';
import { cleanWordKey, dedupeRollingCaptions } from '../../src/clean/index.ts';
import { deepFreeze, ROOT } from './helpers.ts';

const xml = readFileSync(join(ROOT, 'providers/youtube/test/fixtures/timedtext-cCPsdFdlshc-en-asr.srv3.xml'), 'utf8');

function words(segments: { text: string }[]): string[] {
  return segments.flatMap((s) => s.text.split(/\s+/).filter(Boolean));
}

function sharedEdge(a: string, b: string): number {
  const x = a.split(/\s+/).map(cleanWordKey);
  const y = b.split(/\s+/).map(cleanWordKey);
  for (let k = Math.min(x.length, y.length); k > 0; k--) {
    if (x.slice(-k).join(' ') === y.slice(0, k).join(' ')) return k;
  }
  return 0;
}

describe('dedupeRollingCaptions on the real cCPsdFdlshc auto-caption track', () => {
  const source = deepFreeze(parseSrv3(xml));
  const { segments, report } = dedupeRollingCaptions(source);

  it('removes the rolling overlaps, so no neighbours share an edge of 2 or more words', () => {
    // The real track has one 2-word overlap: "...available with the" | "with the m113 yep...".
    expect(source.some((s, i) => i > 0 && sharedEdge(source[i - 1]?.text ?? '', s.text) >= 2)).toBe(true);
    for (let i = 1; i < segments.length; i++) {
      expect(sharedEdge(segments[i - 1]?.text ?? '', segments[i]?.text ?? '')).toBeLessThan(2);
    }
    expect(report.rewritten).toBe(1);
    expect(report.examples[0]).toMatchObject({
      before: 'with the m113 yep up until 20 through',
      after: 'm113 yep up until 20 through',
    });
  });

  it('drops words, keeps every other word in source order, and keeps timings', () => {
    const before = words(source);
    const after = words(segments);
    expect(after.length).toBe(before.length - 2);
    let j = 0;
    for (const w of after) {
      while (j < before.length && before[j] !== w) j++;
      expect(j).toBeLessThan(before.length);
      j++;
    }
    expect(segments.map((s) => s.startSec)).toEqual(source.map((s) => s.startSec));
  });

  it('keeps single shared words at cue boundaries, which can be real speech', () => {
    const one = source.findIndex((s, i) => i > 0 && sharedEdge(source[i - 1]?.text ?? '', s.text) === 1);
    expect(one).toBeGreaterThan(0);
    expect(segments[one]?.text).toBe(source[one]?.text);
  });

  it('merges a cue that only repeats the previous one, keeping the earlier start', () => {
    const real = source.slice(0, 2);
    const repeat = { startSec: real[1]?.startSec ?? 0, endSec: (real[1]?.endSec ?? 0) + 1, text: real[1]?.text ?? '' };
    const res = dedupeRollingCaptions([...real, repeat]);
    expect(res.segments).toHaveLength(2);
    expect(res.segments[1]?.endSec).toBe(repeat.endSec);
    expect(res.report.merged).toBe(1);
  });
});
