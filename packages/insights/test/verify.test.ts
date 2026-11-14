import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { normalize, parseSeconds, THRESHOLD, verifyCitations, verifyQuote } from '../src/index.ts';

// Real auto-captions: part 1 of the Alliance Motorworks G-Wagon buyer's series (tests/fixtures/README.md).
const gwagon = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json'), 'utf8'),
) as VideoContext;

describe('normalize', () => {
  it('folds case, punctuation, apostrophes and diacritics', () => {
    expect(normalize("It's the LEGENDARY M113, V8!")).toBe('its the legendary m113 v8');
    expect(normalize('Café & Crème')).toBe('cafe and creme');
  });
  it('parses timestamps in seconds or clock form', () => {
    expect(parseSeconds(71)).toBe(71);
    expect(parseSeconds('1:11')).toBe(71);
    expect(parseSeconds('71s')).toBe(71);
    expect(parseSeconds('1:02:03')).toBe(3723);
    expect(Number.isNaN(parseSeconds('soon'))).toBe(true);
  });
});

describe('verifyQuote on real transcript text', () => {
  it('passes an exact quote spanning segments and snaps to the segment where it starts', () => {
    // Segments 69.36 "to this one has what we know the" and 71.119 "legendary m113 V8 this was Mercedes big".
    const r = verifyQuote(gwagon, 'this one has what we know the legendary M113 V8', 75);
    expect(r.ok).toBe(true);
    expect(r.score).toBe(1);
    expect(r.startSec).toBe(69.36);
    expect(r.endSec).toBe(75.479);
  });

  it('passes a quote with punctuation and case a model would add', () => {
    const r = verifyQuote(gwagon, "This is a great motor. I love this motor; I think they're very reliable.", '10:05');
    expect(r.ok).toBe(true);
    expect(r.startSec).toBe(610.04);
  });

  it('passes a near-verbatim quote with one word in nine changed (score >= threshold)', () => {
    // Real: "they make the right amount of power for big stuff"; one word swapped.
    const r = verifyQuote(gwagon, 'they make the right amount of power for heavy stuff', 615);
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(THRESHOLD);
    expect(r.score).toBeLessThan(1);
  });

  it('rejects a paraphrase in other words', () => {
    const r = verifyQuote(gwagon, 'the M113 engine is among the most dependable eight cylinder motors Mercedes ever built', 75);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('quote-not-found');
    expect(r.score).toBeLessThan(THRESHOLD);
  });

  it('rejects a real quote cited at the wrong time and says where it really is', () => {
    const r = verifyQuote(gwagon, 'this one has what we know the legendary M113 V8', 600);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('quote-at-other-time');
    expect(r.foundAtSec).toBe(69.36);
  });

  it('accepts a timestamp within the 30 s window and fixes it', () => {
    const r = verifyQuote(gwagon, 'this one has what we know the legendary M113 V8', 95);
    expect(r.ok).toBe(true);
    expect(r.startSec).toBe(69.36);
  });

  it('rejects a quote that is not in the video', () => {
    const r = verifyQuote(gwagon, 'the diesel G350 Bluetec is the one we recommend to everyone', 300);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('quote-not-found');
  });

  it('rejects quotes too short to prove anything, and bad timestamps', () => {
    expect(verifyQuote(gwagon, 'this motor', 610).reason).toBe('quote-too-short');
    expect(verifyQuote(gwagon, 'I love this motor I think', 'later').reason).toBe('bad-timestamp');
    expect(verifyQuote(gwagon, '', 610).reason).toBe('no-quote');
  });
});

describe('verifyCitations', () => {
  it('splits claims into verified (with ids, links and snapped times) and unverified (with reasons)', () => {
    const { verified, unverified, ids } = verifyCitations(
      [
        {
          claim: 'The 2000 G500 has the M113 V8.',
          quote: 'this one has what we know the legendary m113 V8',
          videoId: 'V1',
          startSec: 71,
          topic: 'engines',
        },
        {
          claim: 'Made up.',
          quote: 'the diesel G350 Bluetec is the one we recommend to everyone',
          videoId: 'cCPsdFdlshc',
          startSec: 300,
          topic: 'engines',
        },
        {
          claim: 'Wrong video.',
          quote: 'this one has what we know the legendary m113 V8',
          videoId: 'V9',
          startSec: 71,
          topic: 'engines',
        },
        {
          claim: 'The 5.5 is very reliable.',
          quote: "I love this motor I think they're very reliable",
          videoId: 'youtube:cCPsdFdlshc',
          startSec: '10:10',
          topic: 'Engines',
          stance: 'reliable',
        },
      ],
      [gwagon],
    );
    expect(verified.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(ids).toEqual(['c1', null, null, 'c2']);
    expect(verified[0]?.citation).toMatchObject({
      videoId: 'youtube:cCPsdFdlshc',
      title: gwagon.metadata.title,
      startSec: 69.36,
      url: 'https://www.youtube.com/watch?v=cCPsdFdlshc&t=69s',
    });
    expect(verified[1]?.stance).toBe('reliable');
    expect(unverified.map((u) => u.reason)).toEqual(['quote-not-found', 'unknown-video']);
  });
});
