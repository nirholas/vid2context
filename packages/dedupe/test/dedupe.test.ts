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

describe('distinct videos', () => {
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
    const input = [zooRetro, gwagon, zooOriginal, zoo2021];
    expect(findDuplicates(input)).toEqual(findDuplicates(input));
    expect(JSON.stringify(findDuplicates(input))).toBe(JSON.stringify(findDuplicates(input)));
  });
});
