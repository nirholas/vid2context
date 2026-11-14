import { describe, expect, it } from 'vitest';
import { loadCitationsDataset, loadSearchDataset, loadVideoDataset, videoItemProblems } from '../src/dataset.ts';
import { checkCitation, citationAccuracy } from '../src/metrics/citations.ts';
import { sharedContext } from './helpers.ts';

const gwagon = () => sharedContext('youtube-cCPsdFdlshc.json').transcript.segments;

describe('dataset files', () => {
  it('stt.json lists 10 or more short videos, at least two non-English', () => {
    const d = loadVideoDataset('stt.json');
    expect(d.items.length).toBeGreaterThanOrEqual(10);
    expect(d.items.every((i) => i.durationSec >= 60 && i.durationSec <= 360)).toBe(true);
    const languages = new Set(d.items.map((i) => i.language.split('-')[0]));
    expect([...languages].filter((l) => l !== 'en').length).toBeGreaterThanOrEqual(2);
    expect(d.items.every((i) => i.why.length > 10 && i.license.length > 10)).toBe(true);
  });

  it('captions.json lists videos whose references may be committed', () => {
    const d = loadVideoDataset('captions.json');
    expect(d.items.length).toBeGreaterThanOrEqual(5);
    expect(d.items.every((i) => /NASA|CC BY-NC-ND/.test(i.license))).toBe(true);
  });

  it('reports what is wrong with a malformed entry', () => {
    expect(videoItemProblems({ id: 'x', url: 'u' })).toContain('durationSec must be a positive number');
    expect(videoItemProblems({ id: 'x', url: 'u' })).toContain('reference must be "creator-captions"');
  });

  it('every citations.json quote occurs in the recorded transcript inside its labeled range', () => {
    const d = loadCitationsDataset();
    for (const q of d.questions) {
      for (const e of q.expected) {
        const mid = (e.startSec + e.endSec) / 2;
        const check = checkCitation(gwagon(), { atSec: mid, quote: e.quote }, { toleranceSec: (e.endSec - e.startSec) / 2 });
        expect(check.ok, `${q.id}: ${check.reason} ${check.foundAtSec ?? ''}`).toBe(true);
      }
    }
  });

  it('every search.json range lies inside the recorded transcript', () => {
    const d = loadSearchDataset();
    const end = gwagon().at(-1)?.endSec ?? 0;
    expect(d.queries.length).toBeGreaterThanOrEqual(10);
    for (const q of d.queries) for (const e of q.expected) expect(e.startSec < e.endSec && e.endSec <= end + 1).toBe(true);
  });
});

describe('citation accuracy', () => {
  it('accepts a real quote at its time and rejects it far away', () => {
    const segs = gwagon();
    expect(checkCitation(segs, { atSec: 280, quote: '490 horsepower compressor motor' }).ok).toBe(true);
    const far = checkCitation(segs, { atSec: 900, quote: '490 horsepower compressor motor' });
    expect(far).toMatchObject({ ok: false, reason: 'wrong-time' });
    // "you had a 490 horsepower compressor" runs 279.6 to 281.88 s; "490" is word 4 of 8 once spelled out.
    expect(far.foundAtSec).toBeCloseTo(279.6 + (2.28 * 3) / 8, 6);
  });

  it('rejects quotes that are not in the transcript and quotes too short to mean anything', () => {
    const segs = gwagon();
    expect(checkCitation(segs, { atSec: 280, quote: '600 horsepower compressor motor' }).reason).toBe('not-found');
    expect(checkCitation(segs, { atSec: 280, quote: 'horsepower' }).reason).toBe('quote-too-short');
  });

  it('finds quotes that span two caption segments', () => {
    // "it is known as a Land Cruiser killer" is split across segments in the auto-captions.
    expect(checkCitation(gwagon(), { atSec: 82, quote: 'known as a Land Cruiser killer' }).ok).toBe(true);
  });

  it('scores a set of citations across a collection', () => {
    const map = new Map([['youtube:cCPsdFdlshc', gwagon()]]);
    const res = citationAccuracy(
      [
        { videoId: 'youtube:cCPsdFdlshc', atSec: 310, quote: 'drinks a quart and a half' },
        { videoId: 'youtube:cCPsdFdlshc', atSec: 20, quote: 'drinks a quart and a half' },
        { videoId: 'youtube:other', atSec: 20, quote: 'drinks a quart and a half' },
      ],
      map,
    );
    expect(res.total).toBe(3);
    expect(res.verified).toBe(1);
    expect(res.checks.map((c) => c.reason)).toEqual([undefined, 'wrong-time', 'no-transcript']);
  });
});
