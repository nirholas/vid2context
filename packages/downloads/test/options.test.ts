import { Vid2ContextError } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { clock, findChapter, isTrimmed, normalizeRequest, parseTime } from '../src/options.ts';
import { downloadPolicy } from '../src/policy.ts';

const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

describe('normalizeRequest', () => {
  it('defaults to an mp4 video up to 1080p with everything embedded', () => {
    expect(normalizeRequest({ url: URL })).toEqual({
      input: URL,
      kind: 'video',
      format: 'mp4',
      quality: '1080',
      exactCuts: false,
      embedMetadata: true,
      embedThumbnail: true,
      embedChapters: true,
      subtitles: [],
      removeSegments: [],
    });
  });

  it('reads the kind from the format, and the format from the kind', () => {
    expect(normalizeRequest({ url: URL, format: 'mp3' })).toMatchObject({ kind: 'audio', format: 'mp3', quality: 'best' });
    expect(normalizeRequest({ url: URL, kind: 'audio' })).toMatchObject({ kind: 'audio', format: 'mp3' });
    expect(normalizeRequest({ url: URL, format: '.WEBM' })).toMatchObject({ kind: 'video', format: 'webm' });
  });

  it('accepts quality written as 720p, 192k or 192kbps, and query-string booleans', () => {
    expect(normalizeRequest({ url: URL, quality: '720p' }).quality).toBe('720');
    expect(normalizeRequest({ url: URL, format: 'mp3', quality: '192k' }).quality).toBe('192');
    expect(normalizeRequest({ url: URL, format: 'mp3', quality: 320 }).quality).toBe('320');
    expect(normalizeRequest({ url: URL, embedThumbnail: '0', exactCuts: 'yes' })).toMatchObject({
      embedThumbnail: false,
      exactCuts: true,
    });
  });

  it('takes lists as arrays or comma-separated strings, deduplicated', () => {
    const r = normalizeRequest({ url: URL, subtitles: 'en, de,en', removeSegments: ['sponsor', 'selfpromo'] });
    expect(r.subtitles).toEqual(['en', 'de']);
    expect(r.removeSegments).toEqual(['sponsor', 'selfpromo']);
  });

  it('refuses contradictions and unknown values with a hint', () => {
    const cases = [
      {},
      { url: URL, format: 'avi' },
      { url: URL, kind: 'audio', format: 'mp4' },
      { url: URL, kind: 'picture' },
      { url: URL, quality: '999' },
      { url: URL, format: 'mp3', quality: '1080' },
      { url: URL, from: '1:00', to: '0:30' },
      { url: URL, from: '10', chapter: '1' },
      { url: URL, format: 'mp3', subtitles: 'en' },
      { url: URL, subtitles: 'english!' },
      { url: URL, removeSegments: 'ads' },
      { url: URL, embedMetadata: 'maybe' },
    ];
    for (const raw of cases) {
      let caught: unknown;
      try {
        normalizeRequest(raw);
      } catch (err) {
        caught = err;
      }
      expect(caught, JSON.stringify(raw)).toBeInstanceOf(Vid2ContextError);
      expect((caught as Vid2ContextError).code).toBe('bad-request');
      expect((caught as Vid2ContextError).hint).toBeTruthy();
    }
  });
});

describe('parseTime', () => {
  it('reads seconds, clock times and unit strings', () => {
    expect(parseTime('83')).toBe(83);
    expect(parseTime('83.5')).toBe(83.5);
    expect(parseTime(12)).toBe(12);
    expect(parseTime('1:23')).toBe(83);
    expect(parseTime('1:02:03')).toBe(3723);
    expect(parseTime('90s')).toBe(90);
    expect(parseTime('1m30s')).toBe(90);
    expect(parseTime('1h2m3s')).toBe(3723);
    expect(parseTime('')).toBeUndefined();
    expect(parseTime(undefined)).toBeUndefined();
  });

  it('refuses times that do not parse', () => {
    for (const bad of ['1:75', '1:60:00', 'soon', '-5', -1, '1:2:3:4']) expect(() => parseTime(bad)).toThrow(Vid2ContextError);
  });
});

describe('chapters and clocks', () => {
  const chapters = [{ title: 'Intro' }, { title: 'The elephants' }, { title: 'Outro and thanks' }];

  it('finds a chapter by index, exact title, prefix, then substring', () => {
    expect(findChapter(chapters, '1')?.index).toBe(1);
    expect(findChapter(chapters, 'intro')?.index).toBe(0);
    expect(findChapter(chapters, 'the ele')?.index).toBe(1);
    expect(findChapter(chapters, 'thanks')?.index).toBe(2);
    expect(findChapter(chapters, '7')).toBeUndefined();
    expect(findChapter(chapters, 'giraffes')).toBeUndefined();
  });

  it('formats clocks and knows when a request is trimmed', () => {
    expect(clock(5)).toBe('0:05');
    expect(clock(83)).toBe('1:23');
    expect(clock(3723)).toBe('1:02:03');
    expect(isTrimmed({})).toBe(false);
    expect(isTrimmed({ fromSec: 0 })).toBe(true);
    expect(isTrimmed({ chapter: 'Intro' })).toBe(true);
  });
});

describe('downloadPolicy', () => {
  it('is on locally with no limits', () => {
    const p = downloadPolicy({});
    expect(p.enabled).toBe(true);
    expect(p.maxBytes).toBe(0);
    expect(p.maxDurationSec).toBe(0);
    expect(p.reason).toBeUndefined();
  });

  it('is off on public servers unless the operator opts in, then has limits', () => {
    const off = downloadPolicy({ VID2CONTEXT_PUBLIC: '1' });
    expect(off.enabled).toBe(false);
    expect(off.reason).toContain('VID2CONTEXT_DOWNLOADS=1');
    const on = downloadPolicy({ VID2CONTEXT_PUBLIC: '1', VID2CONTEXT_DOWNLOADS: '1' });
    expect(on.enabled).toBe(true);
    expect(on.maxBytes).toBe(1024 * 1024 * 1024);
    expect(on.maxDurationSec).toBe(120 * 60);
  });

  it('can be turned off everywhere and reads its limits from env', () => {
    const p = downloadPolicy({
      VID2CONTEXT_DOWNLOADS: '0',
      VID2CONTEXT_MAX_DOWNLOAD_MB: '50',
      VID2CONTEXT_DOWNLOAD_TTL_MIN: '5',
    });
    expect(p.enabled).toBe(false);
    expect(p.reason).toContain('VID2CONTEXT_DOWNLOADS=0');
    expect(p.maxBytes).toBe(50 * 1024 * 1024);
    expect(p.ttlMin).toBe(5);
  });
});
