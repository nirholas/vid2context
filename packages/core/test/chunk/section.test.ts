import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getSection, outlineForApi, parseTimeArg, transcriptOutline } from '../../src/chunk/index.ts';
import { item as at } from '../../src/chunk/spans.ts';
import { Vid2ContextError } from '../../src/errors.ts';
import { formatters, render } from '../../src/format/index.ts';
import { segmentsToText } from '../../src/segments.ts';
import { estimateTokens } from '../../src/tokens.ts';
import type { VideoContext } from '../../src/types.ts';

const load = (f: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/contexts/${f}`, import.meta.url), 'utf8'));
const zoo = load('youtube-jNQXAC9IVRw.json');
const gwagon = load('youtube-cCPsdFdlshc.json');

function badRequest(fn: () => unknown): Vid2ContextError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('bad-request');
    return err as Vid2ContextError;
  }
  throw new Error('expected a bad-request error');
}

describe('transcriptOutline', () => {
  it('lists real chapters with token counts', () => {
    const o = transcriptOutline(zoo);
    expect(o.title).toBe('Me at the zoo');
    expect(o.sections.map((s) => [s.title, s.startSec, s.endSec, s.source])).toEqual([
      ['Intro', 0, 5, 'chapters'],
      ['The cool thing', 5, 17, 'chapters'],
      ['End', 17, 19, 'chapters'],
    ]);
    // The last caption starts at 16.9 s, inside "The cool thing", so "End" holds no speech.
    expect(o.sections.map((s) => s.tokens > 0)).toEqual([true, true, false]);
    expect(o.totalTokens).toBe(o.sections.reduce((a, s) => a + s.tokens, 0));
  });

  it('cuts synthetic sections of about five minutes, contiguous, titled by time range', () => {
    const o = transcriptOutline(gwagon);
    expect(o.sections.length).toBe(4);
    expect(at(o.sections, 0).startSec).toBe(0);
    expect(o.sections.at(-1)?.endSec).toBe(o.durationSec);
    for (const [i, s] of o.sections.entries()) {
      expect(s.source).toBe('time');
      expect(s.title).toMatch(/^\d+:\d\d to \d+:\d\d$/);
      if (i > 0) expect(s.startSec).toBe(at(o.sections, i - 1).endSec);
      if (i < o.sections.length - 1) expect(Math.abs(s.endSec - s.startSec - 300)).toBeLessThan(120);
    }
    // Whole-text estimate and sum of sections agree closely.
    const whole = estimateTokens(segmentsToText(gwagon.transcript.segments));
    expect(Math.abs(o.totalTokens - whole) / whole).toBeLessThan(0.01);
  });

  it('outlineForApi matches GET /outline and its tokens sum to totalTokens', () => {
    const api = outlineForApi(gwagon);
    expect(Object.keys(api).sort()).toEqual(['chapters', 'metadata', 'totalTokens']);
    expect(api.metadata).toBe(gwagon.metadata);
    expect(api.chapters.reduce((a, c) => a + c.tokens, 0)).toBe(api.totalTokens);
    for (const c of api.chapters) expect(Object.keys(c).sort()).toEqual(['endSec', 'startSec', 'title', 'tokens']);
    expect(outlineForApi(zoo).chapters.map((c) => c.title)).toEqual(['Intro', 'The cool thing', 'End']);
  });
});

describe('getSection', () => {
  it('slices a time range to the overlapping segments and records the range', () => {
    const s = getSection(gwagon, { fromSec: 60, toSec: 120 });
    const segs = s.transcript.segments;
    expect(segs.length).toBeGreaterThan(10);
    expect(segs.every((x) => x.endSec > 60 && x.startSec < 120)).toBe(true);
    const all = gwagon.transcript.segments.filter((x) => x.endSec > 60 && x.startSec < 120);
    expect(segs).toEqual(all);
    expect(s.metadata.extra?.section).toEqual({ fromSec: 60, toSec: 120 });
    expect(s.metadata.chapters).toEqual([]);
    // The original is untouched.
    expect(gwagon.transcript.segments).toHaveLength(521);
    expect(gwagon.metadata.extra?.section).toBeUndefined();
  });

  it('selects a chapter by index, trims chapters to the range and renders in every formatter', () => {
    const s = getSection(zoo, { chapter: 1 });
    expect(s.transcript.segments.map((x) => x.text)).toEqual(zoo.transcript.segments.slice(1).map((x) => x.text));
    expect(s.metadata.chapters).toEqual([{ title: 'The cool thing', startSec: 5, endSec: 17 }]);
    expect(s.metadata.extra?.section).toEqual({ fromSec: 5, toSec: 17, chapterTitle: 'The cool thing' });
    const text = render(s, 'text', { timestamps: true });
    expect(text).toContain('[0:05] the cool thing about these guys');
    expect(text).not.toContain('elephants');
    for (const id of Object.keys(formatters)) expect(render(s, id, { timestamps: true }).length, id).toBeGreaterThan(0);
  });

  it('matches chapter titles case-insensitively: exact, then prefix, then substring', () => {
    expect(getSection(zoo, { chapter: 'END' }).metadata.extra?.section).toMatchObject({ chapterTitle: 'End' });
    expect(getSection(zoo, { chapter: 'the cool' }).metadata.extra?.section).toMatchObject({
      chapterTitle: 'The cool thing',
    });
    expect(getSection(zoo, { chapter: 'tro' }).metadata.extra?.section).toMatchObject({ chapterTitle: 'Intro' });
    const err = badRequest(() => getSection(zoo, { chapter: 'giraffes' }));
    expect(err.hint).toContain('The cool thing');
    expect(badRequest(() => getSection(zoo, { chapter: 7 })).hint).toContain('2: End');
  });

  it('selects synthetic sections of chapterless videos with the outline token count', () => {
    const o = transcriptOutline(gwagon);
    for (const sec of o.sections) {
      const s = getSection(gwagon, { chapter: sec.index });
      expect(estimateTokens(segmentsToText(s.transcript.segments))).toBe(sec.tokens);
      expect(s.metadata.extra?.section).toEqual({ fromSec: sec.startSec, toSec: sec.endSec, chapterTitle: sec.title });
    }
    expect(getSection(gwagon, { chapter: '5:00 to' }).metadata.extra?.section).toMatchObject({ fromSec: 300.8 });
  });

  it('rejects empty and out-of-range time ranges', () => {
    badRequest(() => getSection(gwagon, { fromSec: 120, toSec: 60 }));
    expect(badRequest(() => getSection(gwagon, { fromSec: 5000 })).hint).toContain('18:05');
  });
});

describe('parseTimeArg', () => {
  it('accepts seconds, m:ss and h:mm:ss', () => {
    expect(parseTimeArg('1:02:03')).toBe(3723);
    expect(parseTimeArg('75')).toBe(75);
    expect(parseTimeArg('754')).toBe(754);
    expect(parseTimeArg('12:34')).toBe(754);
    expect(parseTimeArg(' 0:05 ')).toBe(5);
    expect(parseTimeArg('90:00')).toBe(5400);
    expect(parseTimeArg('75.5')).toBe(75.5);
    expect(parseTimeArg(42)).toBe(42);
  });

  it('rejects malformed times with a hint', () => {
    for (const v of ['12:5', '1:60', '1:2:03', '', 'abc', '-5', '1:02:03:04', '5s']) {
      expect(badRequest(() => parseTimeArg(v)).hint, v).toContain('h:mm:ss');
    }
    badRequest(() => parseTimeArg(-1));
    badRequest(() => parseTimeArg(Number.NaN));
  });
});
