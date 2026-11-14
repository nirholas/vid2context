import type { VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { findDuplicates } from '../src/dedupe.ts';
import { loadFixture } from './helpers.ts';

/** Copies of real fixtures under distinct ids: the transcripts are untouched, only the ref id differs per copy. */
function repeat(contexts: VideoContext[], times: number): VideoContext[] {
  const out: VideoContext[] = [];
  for (let k = 0; k < times; k++) {
    for (const c of contexts) {
      out.push({ ...c, metadata: { ...c.metadata, ref: { ...c.metadata.ref, id: `${c.metadata.ref.id}#${k}` } } });
    }
  }
  return out;
}

describe('performance', () => {
  it('handles 200 copies of an 18-minute transcript (60 hours, every pair a duplicate) well within a minute', () => {
    const contexts = repeat([loadFixture('youtube-cCPsdFdlshc.json', 'shared')], 200);
    const started = performance.now();
    const res = findDuplicates(contexts);
    const ms = performance.now() - started;
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]?.members).toHaveLength(200);
    expect(res.stats.candidatePairs).toBe(19_900);
    // Pairs already in one reupload cluster are not aligned again.
    expect(res.stats.comparedPairs).toBe(199);
    expect(ms).toBeLessThan(60_000);
  });
});
