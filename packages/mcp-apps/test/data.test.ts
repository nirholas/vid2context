import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatTimestamp as coreFormat, type VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { toViewerData } from '../src/context.ts';
import { citation, formatTimestamp, isViewerData, timestampLink } from '../src/data.ts';

const load = (file: string): VideoContext =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts', file), 'utf8')) as VideoContext;

describe('viewer data', () => {
  it("formats timestamps exactly like core's formatTimestamp", () => {
    for (let sec = -5; sec <= 4000; sec += 0.75) expect(formatTimestamp(sec)).toBe(coreFormat(sec));
    for (const sec of [35999, 36000, 86399.9, 360000]) expect(formatTimestamp(sec)).toBe(coreFormat(sec));
  });

  it('keeps every raw segment as a [start, end, text] tuple', () => {
    const context = load('youtube-cCPsdFdlshc.json');
    const data = toViewerData(context);
    expect(data.segments).toHaveLength(context.transcript.segments.length);
    data.segments.forEach(([start, end, text], i) => {
      const s = context.transcript.segments[i] as VideoContext['transcript']['segments'][number];
      expect(text).toBe(s.text);
      expect(Math.abs(start - s.startSec)).toBeLessThan(0.006);
      expect(Math.abs(end - s.endSec)).toBeLessThan(0.006);
    });
    expect(isViewerData(data)).toBe(true);
    expect(isViewerData({ ...data, segments: [[0, 1]] })).toBe(false);
    expect(isViewerData(null)).toBe(false);
  });

  it('turns the YouTube deep link into a template and back', () => {
    const data = toViewerData(load('youtube-jNQXAC9IVRw.json'));
    expect(data.timestampBase).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw&t={t}s');
    expect(timestampLink(data.timestampBase, 12.6)).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s');
    expect(data.chapters).toEqual([
      { title: 'Intro', startSec: 0, endSec: 5 },
      { title: 'The cool thing', startSec: 5, endSec: 17 },
      { title: 'End', startSec: 17, endSec: 19 },
    ]);
    expect(citation('Me at the zoo', 12.6, data.timestampBase)).toBe(
      '[Me at the zoo @ 0:12](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s)',
    );
    expect(citation('A [bracketed] title', 75, null)).toBe('[A \\[bracketed\\] title @ 1:15]');
  });
});
