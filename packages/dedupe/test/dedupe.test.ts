import type { VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { findDuplicates, independentSources, titleSimilarity } from '../src/dedupe.ts';
import { resolveOptions } from '../src/options.ts';
import { loadFixture } from './helpers.ts';

const zooOriginal = loadFixture('youtube-jNQXAC9IVRw.json', 'shared');
const gwagon = loadFixture('youtube-cCPsdFdlshc.json', 'shared');
const zooRetro = loadFixture('youtube-g5RBHWskGtc.json');
const zoo2021 = loadFixture('youtube-9Pd5fi1DCb8.json');

const idOf = (c: VideoContext) => c.metadata.ref.id;

describe('reuploads', () => {
  it('groups real reuploads of "Me at the zoo" with the original despite word-level caption differences', () => {
    const res = findDuplicates([zooRetro, gwagon, zooOriginal, zoo2021]);
    expect(res.groups).toHaveLength(1);
    const g = res.groups[0];
    expect(g?.kind).toBe('reupload');
    // The original wins on view count (the files carry no publish date).
    expect(g?.original).toBe(idOf(zooOriginal));
    expect(g?.members.map((m) => m.videoId)).toEqual([idOf(zooOriginal), idOf(zooRetro), idOf(zoo2021)]);
    for (const m of g?.members.slice(1) ?? []) {
      expect(m.evidence?.overlap).toBeGreaterThan(0.8);
      expect(m.evidence?.method).toBe('shingles');
      expect(m.offsetSec).toBeUndefined();
    }
    expect(res.representativeOf[idOf(zoo2021)]).toBe(idOf(zooOriginal));
    expect(res.representativeOf[idOf(gwagon)]).toBe(idOf(gwagon));
  });

  it('independentSources keeps one video per group, in input order', () => {
    const kept = independentSources([zooRetro, gwagon, zooOriginal, zoo2021]);
    expect(kept.map(idOf)).toEqual([idOf(gwagon), idOf(zooOriginal)]);
  });
});

// Lex Fridman Podcast #118 (2h08m) and three Lex Clips excerpts of it. True offsets were found by matching clip
// sentences to the episode transcript by hand; the evidence is in test/fixtures/README.md.
const episode = loadFixture('youtube-U_6AYX42gkU.json');
const snuggle = loadFixture('youtube-J_n3wupU2dg.json');
const feynman = loadFixture('youtube-YrGuJ4Pkkuo.json');
const topology = loadFixture('youtube-Ge0ggAtmL54.json');
const TRUE_OFFSET: Record<string, number> = {
  [idOf(snuggle)]: 1416.2,
  [idOf(feynman)]: 311.8,
  [idOf(topology)]: 1123.1,
};

describe('clips', () => {
  it('finds three real clips of a full episode, each at its true offset', () => {
    const res = findDuplicates([topology, gwagon, episode, snuggle, zooOriginal, feynman]);
    expect(res.groups).toHaveLength(1);
    const g = res.groups[0];
    expect(g?.kind).toBe('clip');
    expect(g?.original).toBe(idOf(episode));
    expect(g?.members.map((m) => m.videoId)).toEqual([idOf(episode), idOf(topology), idOf(snuggle), idOf(feynman)]);
    for (const m of g?.members.slice(1) ?? []) {
      expect(m.evidence?.method).toBe('shingles');
      expect(m.evidence?.overlap).toBeGreaterThan(0.95);
      expect(Math.abs((m.offsetSec as number) - (TRUE_OFFSET[m.videoId] as number))).toBeLessThan(3);
      // The covered range sits inside the episode, starting near the offset.
      expect(m.coveredRange?.startSec).toBeGreaterThanOrEqual((m.offsetSec as number) - 3);
      expect(m.coveredRange?.endSec).toBeLessThanOrEqual(episode.metadata.durationSec as number);
    }
    const topo = g?.members.find((m) => m.videoId === idOf(topology));
    // The topology clip runs from 18:43 to 23:37 of the episode.
    expect(topo?.coveredRange?.startSec).toBeCloseTo(1123, 0);
    expect(topo?.coveredRange?.endSec).toBeCloseTo(1417, 0);
    for (const c of [snuggle, feynman, topology]) expect(res.representativeOf[idOf(c)]).toBe(idOf(episode));
    expect(res.related).toEqual([]);
  });

  it('keeps clips of different passages of one episode apart from each other when the episode is absent', () => {
    // Adjacent excerpts (topology ends at 23:37, the mug remark starts at 23:38) share no speech.
    const res = findDuplicates([snuggle, feynman, topology]);
    expect(res.groups).toEqual([]);
    expect(res.related).toEqual([]);
  });

  it('independentSources counts the episode once, not four times', () => {
    const kept = independentSources([snuggle, episode, feynman, topology, gwagon]);
    expect(kept.map(idOf)).toEqual([idOf(episode), idOf(gwagon)]);
  });

  it('handles reuploads and clips in one collection', () => {
    const res = findDuplicates([zooRetro, feynman, zooOriginal, episode, zoo2021, gwagon]);
    expect(res.groups.map((g) => [g.kind, g.original, g.members.length])).toEqual([
      ['reupload', idOf(zooOriginal), 3],
      ['clip', idOf(episode), 2],
    ]);
    expect(new Set(Object.values(res.representativeOf))).toEqual(new Set([idOf(zooOriginal), idOf(episode), idOf(gwagon)]));
  });
});

describe('distinct videos', () => {
  it('never groups any two of the unrelated fixtures', () => {
    const res = findDuplicates([zooOriginal, gwagon, episode]);
    expect(res.groups).toEqual([]);
    expect(res.related).toEqual([]);
  });

  it('never groups the two shared contexts', () => {
    const res = findDuplicates([zooOriginal, gwagon]);
    expect(res.groups).toEqual([]);
    expect(res.related).toEqual([]);
    expect(res.representativeOf).toEqual({ [idOf(zooOriginal)]: idOf(zooOriginal), [idOf(gwagon)]: idOf(gwagon) });
  });
});

describe('inputs', () => {
  it('reports a video given twice once', () => {
    const res = findDuplicates([zooOriginal, zooOriginal, gwagon]);
    expect(res.skipped).toEqual([{ videoId: idOf(zooOriginal), reason: 'duplicate-input' }]);
    expect(res.stats.videos).toBe(2);
  });

  it('skips transcripts too short to judge instead of guessing', () => {
    const res = findDuplicates([zooOriginal, zooRetro], { minWords: 100 });
    expect(res.groups).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual(['too-short', 'too-short']);
  });

  it('rejects bad options with a hint', () => {
    expect(() => resolveOptions({ clipOverlap: 1.5 })).toThrow(/clipOverlap/);
    expect(() => resolveOptions({ blockShingles: 0 })).toThrow(/blockShingles/);
    expect(() => resolveOptions({ nope: 1 })).toThrow(/Unknown dedupe option/);
    expect(() => resolveOptions({ numHashes: 16, bands: 32 })).toThrow(/bands/);
  });
});

describe('metadata', () => {
  it('scores real titles while ignoring words like "reupload"', () => {
    expect(titleSimilarity(zooOriginal.metadata.title, zooRetro.metadata.title)).toBe(1);
    expect(titleSimilarity(zooOriginal.metadata.title, gwagon.metadata.title)).toBe(0);
  });
});

describe('determinism', () => {
  it('returns the same result for the same input', () => {
    const input = [zooRetro, feynman, gwagon, zooOriginal, snuggle, episode, zoo2021, topology];
    expect(findDuplicates(input)).toEqual(findDuplicates(input));
    expect(JSON.stringify(findDuplicates(input))).toBe(JSON.stringify(findDuplicates(input)));
  });
});
