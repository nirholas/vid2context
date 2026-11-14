import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSubtitles, parseTimestamp } from '../src/subtitles.ts';

// Real files: the Commons SRT for the Apollo 11 clip and one of Apple's bipbop HLS WebVTT segments.
const SRT = readFileSync(join(import.meta.dirname, '../../../packages/ffmpeg/test/fixtures/apollo11-first-steps.en.srt'), 'utf8');
const VTT = readFileSync(join(import.meta.dirname, 'fixtures/bipbop_eng_fileSequence0.webvtt'), 'utf8');

describe('parseTimestamp', () => {
  it('reads SRT and WebVTT timings', () => {
    expect(parseTimestamp('00:00:47,772')).toBe(47.772);
    expect(parseTimestamp('01:02:03.5')).toBe(3723.5);
    expect(parseTimestamp('02:03.040')).toBe(123.04);
    expect(parseTimestamp('1:00:00')).toBe(3600);
  });
});

describe('parseSubtitles', () => {
  it('parses a real SRT with multi-line cues and trailing spaces', () => {
    const segs = parseSubtitles(SRT);
    expect(segs).toHaveLength(7);
    expect(segs[0]).toEqual({ startSec: 0.5, endSec: 3.26, text: "I'm at the foot of the ladder." });
    expect(segs[1]?.text).toBe('The LEM footpads are only depressed in the surface about one or two inches,');
    expect(segs[6]).toEqual({ startSec: 47.772, endSec: 55.822, text: "That's one small step for [a] man, one giant leap for mankind." });
  });

  it('gives the same result with a BOM and CRLF line endings', () => {
    expect(parseSubtitles(`﻿${SRT.replace(/\n/g, '\r\n')}`)).toEqual(parseSubtitles(SRT));
  });

  it('parses real WebVTT: header, timestamp map, tags and cue settings', () => {
    const segs = parseSubtitles(VTT);
    expect(segs[0]).toEqual({ startSec: 1, endSec: 3, text: 'English subtitle 1 -Unforced- (00:00:01.000)' });
    expect(segs[1]?.text).toBe('English subtitle 2 -Unforced- (00:00:03.000) Italics');
    expect(segs[4]?.text).toBe('English subtitle 5 -Forced- (00:00:09.000) Italics - BOLD - UNDERLINE');
    expect(segs[5]).toEqual({ startSec: 11, endSec: 13, text: 'English subtitle 6 -Unforced- (00:00:11.000) align start' });
    for (const s of segs) expect(s.text).not.toMatch(/[<>]|X-TIMESTAMP/);
    for (let i = 1; i < segs.length; i++) expect(segs[i]?.startSec).toBeGreaterThanOrEqual(segs[i - 1]?.startSec ?? 0);
  });
});
