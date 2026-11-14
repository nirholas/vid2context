/**
 * Building blocks on the real G-Wagon and zoo transcripts: tokenizer, BM25,
 * chunking, query parsing, reciprocal rank fusion, hit merging, highlighting.
 */
import { describe, expect, it } from 'vitest';
import { Bm25Index } from '../src/bm25.ts';
import { chunkTranscript } from '../src/chunk.ts';
import { reciprocalRankFusion } from '../src/fuse.ts';
import { highlight, mergeAdjacent, type RankedChunk, rangeText } from '../src/merge.ts';
import { parseQuery, passesConstraints } from '../src/query.ts';
import { formatTime } from '../src/shared.ts';
import { indexTerms, phraseWords, stem, terms } from '../src/tokenize.ts';
import { GWAGON, loadContext, ZOO } from './helpers.ts';

const gwagon = loadContext(GWAGON);
const zoo = loadContext(ZOO);

describe('tokenizer', () => {
  it('stems plurals and verb forms onto one term', () => {
    expect(stem('chains')).toBe('chain');
    expect(stem('trucks')).toBe('truck');
    expect(stem('batteries')).toBe('battery');
    expect(stem('drinking')).toBe('drink');
    expect(stem('stopped')).toBe('stop');
    expect(stem('upgraded')).toBe('upgrad');
    expect(stem('upgrade')).toBe('upgrade');
    expect(stem('class')).toBe('class');
  });

  it('keeps model codes whole and also indexes their parts', () => {
    expect(terms('the legendary m113 V8')).toEqual(['legendary', 'm113', 'v8']);
    expect(indexTerms('W463A platform')).toEqual(['w463a', 'w', '463', 'platform'].filter((t) => t.length > 1));
    expect(indexTerms('G550')).toEqual(['g550', '550']);
  });

  it('drops stop words and caption filler, folds diacritics', () => {
    expect(terms('uh so the cool thing is that')).toEqual(['cool', 'thing']);
    expect(terms('Café Über')).toEqual(['cafe', 'uber']);
  });
});

describe('chunkTranscript', () => {
  const chunks = chunkTranscript(gwagon);

  it('makes 30 to 60 second windows plus a short overlap', () => {
    expect(chunks.length).toBeGreaterThan(25);
    for (const [i, c] of chunks.entries()) {
      const coreStart = i === 0 ? c.startSec : (chunks[i - 1] as (typeof chunks)[number]).endSec;
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(75);
      if (i > 0 && i < chunks.length - 1) expect(c.endSec - c.startSec).toBeGreaterThanOrEqual(28);
      expect(c.startSec).toBeLessThanOrEqual(coreStart);
    }
  });

  it('covers every segment and maps back to the raw transcript', () => {
    const segs = gwagon.transcript.segments;
    expect(chunks[0]?.segmentRange[0]).toBe(0);
    expect(chunks.at(-1)?.segmentRange[1]).toBe(segs.length - 1);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1] as (typeof chunks)[number];
      const cur = chunks[i] as (typeof chunks)[number];
      expect(cur.segmentRange[0]).toBeLessThanOrEqual(prev.segmentRange[1] + 1);
      expect(cur.segmentRange[1]).toBeGreaterThan(prev.segmentRange[1]);
    }
    expect(chunks[2]?.text).toContain('2015 G550');
  });

  it('never crosses a chapter start and records the chapter', () => {
    const z = chunkTranscript(zoo);
    expect(z.map((c) => c.chapterTitle)).toEqual(['Intro', 'The cool thing']);
    expect(z[0]?.text).toBe('All right, so here we are, in front of the elephants');
    expect(z[1]?.text).toContain('really really long trunks');
  });

  it('is deterministic, so ids are stable across re-index', () => {
    expect(chunkTranscript(gwagon).map((c) => c.id)).toEqual(chunks.map((c) => c.id));
    expect(chunks[0]?.id).toBe('youtube:cCPsdFdlshc#0.64');
  });
});

describe('Bm25Index', () => {
  const chunks = chunkTranscript(gwagon);
  const index = new Bm25Index();
  for (const c of chunks) index.add(c.id, c.videoId, c.text);
  const top = (q: string) => index.search(indexTerms(q), { limit: 3 }).map((h) => chunks.find((c) => c.id === h.id));

  it('finds exact model codes', () => {
    const [first] = top('M278');
    expect(first?.text.toLowerCase()).toContain('m278');
  });

  it('finds the timing chain through stemming', () => {
    const [first] = top('timing chain');
    expect(first?.text).toContain('timing Chains');
  });

  it('weights rare terms above common ones', () => {
    expect(index.idf('arkansa')).toBeGreaterThan(index.idf('truck'));
  });

  it('scores spoken parts of a code: "M113" also finds "the 113 motor"', () => {
    const hits = index.search(indexTerms('M113'), { limit: 10 }).map((h) => chunks.find((c) => c.id === h.id)?.text ?? '');
    expect(hits.some((t) => t.includes('uses a 113 motor'))).toBe(true);
  });

  it('removes and re-adds a whole video', () => {
    index.removeGroup(gwagon.metadata.ref.id);
    expect(index.size).toBe(0);
    expect(index.search(['chain'])).toEqual([]);
    for (const c of chunks) index.add(c.id, c.videoId, c.text);
    expect(index.size).toBe(chunks.length);
  });

  it('respects the allow filter', () => {
    expect(index.search(indexTerms('timing chain'), { allow: () => false })).toEqual([]);
  });
});

describe('parseQuery', () => {
  it('splits words, phrases and exclusions', () => {
    const q = parseQuery('"Land Cruiser killer" reliable -turbo -"oil cooler"');
    expect(q.text).toBe('Land Cruiser killer reliable');
    expect(q.phrases).toEqual([['land', 'cruiser', 'killer']]);
    expect(q.excluded).toEqual([['turbo'], ['oil', 'cooler']]);
    expect(q.display).toEqual({ phrases: ['Land Cruiser killer'], excluded: ['turbo', 'oil cooler'] });
    expect(q.terms).toEqual(['land', 'cruiser', 'killer', 'reliable']);
  });

  it('keeps hyphenated words and treats an unbalanced quote as text', () => {
    expect(parseQuery('seven-speed automatic').excluded).toEqual([]);
    const q = parseQuery('"timing chain');
    expect(q.phrases).toEqual([]);
    expect(q.terms).toEqual(['tim', 'chain']);
  });

  it('applies phrase and exclusion constraints to real chunk text', () => {
    const chunks = chunkTranscript(gwagon);
    const cruiser = chunks.find((c) => c.text.includes('Land Cruiser killer'));
    const cooler = chunks.find((c) => c.text.includes('oil cooler'));
    expect(cruiser && cooler).toBeTruthy();
    const q = parseQuery('"land cruiser killers"');
    expect(passesConstraints(q, phraseWords(cruiser?.text ?? ''))).toBe(true);
    expect(passesConstraints(q, phraseWords(cooler?.text ?? ''))).toBe(false);
    const neg = parseQuery('oil -coolers');
    expect(passesConstraints(neg, phraseWords(cooler?.text ?? ''))).toBe(false);
  });
});

describe('reciprocalRankFusion', () => {
  it('sums 1/(k + rank) over lists', () => {
    const fused = reciprocalRankFusion(
      [
        { side: 'keyword', ids: ['a', 'b', 'c'] },
        { side: 'vector', ids: ['c', 'a', 'd'] },
      ],
      60,
    );
    const score = (id: string) => fused.find((f) => f.id === id)?.score;
    expect(score('a')).toBeCloseTo(1 / 61 + 1 / 62);
    expect(score('c')).toBeCloseTo(1 / 63 + 1 / 61);
    expect(score('d')).toBeCloseTo(1 / 63);
    expect(fused.map((f) => f.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(fused[0]?.sources).toEqual(['keyword', 'vector']);
    expect(fused[0]?.ranks).toEqual({ keyword: 1, vector: 2 });
  });

  it('applies weights and ignores duplicate ids within one list', () => {
    const fused = reciprocalRankFusion(
      [
        { side: 'keyword', ids: ['a', 'a', 'b'], weight: 1 },
        { side: 'vector', ids: ['b'], weight: 3 },
      ],
      60,
    );
    expect(fused[0]?.id).toBe('b');
    expect(fused.find((f) => f.id === 'a')?.score).toBeCloseTo(1 / 61);
  });

  it('returns nothing for empty lists', () => {
    expect(reciprocalRankFusion([{ side: 'keyword', ids: [] }])).toEqual([]);
  });
});

describe('mergeAdjacent and highlight', () => {
  const chunks = chunkTranscript(gwagon);
  const ranked = (idx: number[]): RankedChunk[] =>
    idx.map((i, r) => {
      const c = chunks[i] as (typeof chunks)[number];
      return {
        id: c.id,
        videoId: c.videoId,
        startSec: c.startSec,
        endSec: c.endSec,
        segmentRange: c.segmentRange,
        score: 1 / (60 + r + 1),
        sources: [r % 2 ? 'vector' : 'keyword'],
      };
    });

  it('merges overlapping neighbours into one range without repeating text', () => {
    const merged = mergeAdjacent(ranked([3, 10, 2]));
    expect(merged).toHaveLength(2);
    const [first, second] = merged;
    expect(first?.chunkIds).toEqual([chunks[3]?.id, chunks[2]?.id]);
    expect(first?.startSec).toBe(chunks[2]?.startSec);
    expect(first?.endSec).toBe(chunks[3]?.endSec);
    expect(first?.sources).toEqual(['keyword']);
    expect(first?.rank).toBe(0);
    expect(second?.rank).toBe(1);
    const text = rangeText(gwagon.transcript.segments, first?.segmentRange ?? [0, 0]);
    const once = 'can always get parts for it';
    expect(text.split(once).length - 1).toBe(1);
  });

  it('coalesces ranges that a later chunk bridges, and caps range length', () => {
    const bridged = mergeAdjacent(ranked([2, 4, 3]));
    expect(bridged).toHaveLength(1);
    expect(bridged[0]?.sources).toEqual(['keyword', 'vector']);
    const capped = mergeAdjacent(ranked([2, 3, 4, 5, 6]), { maxRangeSec: 90 });
    expect(capped.length).toBeGreaterThan(1);
    for (const r of capped) expect(r.endSec - r.startSec).toBeLessThanOrEqual(90);
  });

  it('highlights stemmed matches and trims long text to the densest window', () => {
    const text = rangeText(gwagon.transcript.segments, chunks[2]?.segmentRange ?? [0, 0]);
    const out = highlight(text, parseQuery('timing chain').terms, { maxChars: 160 });
    expect(out).toContain('**timing**');
    expect(out).toContain('**Chains**');
    expect(out.length).toBeLessThanOrEqual(160 + 6 + 4 * 4);
    expect(out.startsWith('...')).toBe(true);
    expect(highlight('the legendary m113 V8', parseQuery('M113').terms)).toBe('the legendary **m113** V8');
  });
});

describe('small helpers', () => {
  it('formats times', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(92.6)).toBe('1:32');
    expect(formatTime(3725)).toBe('1:02:05');
  });
});
