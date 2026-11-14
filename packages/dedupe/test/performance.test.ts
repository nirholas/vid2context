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
    console.error(`[dedupe perf] 200 x 18 min: ${Math.round(ms)} ms, ${JSON.stringify(res.stats)}`);
  });

  it('handles 100 copies of a 2h08m episode (214 hours of speech)', () => {
    const contexts = repeat([loadFixture('youtube-U_6AYX42gkU.json')], 100);
    const started = performance.now();
    const res = findDuplicates(contexts);
    const ms = performance.now() - started;
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]?.members).toHaveLength(100);
    expect(ms).toBeLessThan(120_000);
    console.error(`[dedupe perf] 100 x 2h08m: ${Math.round(ms)} ms, ${JSON.stringify(res.stats)}`);
  });

  it('handles 94 copies of the episode and of each of its three clips (376 videos, 209 hours) without aligning every clip copy against every episode copy', () => {
    const real = ['youtube-U_6AYX42gkU.json', 'youtube-J_n3wupU2dg.json', 'youtube-YrGuJ4Pkkuo.json', 'youtube-Ge0ggAtmL54.json'];
    const contexts = repeat(
      real.map((n) => loadFixture(n)),
      94,
    );
    const started = performance.now();
    const res = findDuplicates(contexts);
    const ms = performance.now() - started;
    expect(res.groups.map((g) => [g.kind, g.members.length])).toEqual([
      ['reupload', 94],
      ['clip', 1 + 3 * 94],
      ['reupload', 94],
      ['reupload', 94],
      ['reupload', 94],
    ]);
    const episodeId = 'youtube:U_6AYX42gkU#0';
    expect(new Set(Object.values(res.representativeOf))).toEqual(new Set([episodeId]));
    // Without skipping clip-linked cluster pairs this compares 26,880 pairs.
    expect(res.stats.comparedPairs).toBeLessThan(2_000);
    expect(ms).toBeLessThan(120_000);
    console.error(`[dedupe perf] 94 x (episode + 3 clips): ${Math.round(ms)} ms, ${JSON.stringify(res.stats)}`);
  });
});
