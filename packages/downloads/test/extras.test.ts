/**
 * The runtime-neutral helpers behind thumbnails, burned subtitles and chapter
 * splits. Inputs are real: the yt-dlp info dumps in fixtures/ and the
 * Wikimedia Commons subtitle file shared with packages/ffmpeg.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  chapterParts,
  normalizeExtras,
  normalizeThumbnailRequest,
  partName,
  pickThumbnail,
  shiftSubtitles,
  sniffImage,
} from '../src/extras.ts';
import { normalizeRequest } from '../src/options.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const SRT = fileURLToPath(new URL('../../ffmpeg/test/fixtures/apollo11-first-steps.en.srt', import.meta.url));

async function info(name: string) {
  return JSON.parse(await readFile(fixture(name), 'utf8')) as {
    thumbnail?: string;
    thumbnails?: { url?: string; width?: number; height?: number; preference?: number }[];
    chapters?: { start_time?: number; end_time?: number; title?: string }[];
    duration?: number;
  };
}

describe('pickThumbnail', () => {
  it('takes the largest image from a real YouTube info dump', async () => {
    const i = await info('info-youtube-jNQXAC9IVRw.json');
    const pick = pickThumbnail(i.thumbnails, i.thumbnail);
    expect(pick?.url).toMatch(/^https:\/\/i\.ytimg\.com\//);
    const widest = Math.max(...(i.thumbnails ?? []).map((t) => (t.width ?? 0) * (t.height ?? 0)));
    if (widest > 0) expect((pick?.width ?? 0) * (pick?.height ?? 0)).toBe(widest);
  });

  it('falls back to the single thumbnail field, and refuses non-http values', () => {
    expect(pickThumbnail(undefined, 'https://example.org/a.jpg')).toEqual({ url: 'https://example.org/a.jpg' });
    expect(pickThumbnail([{ url: 'file:///etc/passwd' }], null)).toBeUndefined();
  });
});

describe('sniffImage', () => {
  it('recognises jpg, png and webp headers', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImage(new TextEncoder().encode('<html>'))).toBeUndefined();
  });
});

describe('normalizeThumbnailRequest', () => {
  it('defaults to jpg and accepts jpeg as jpg', () => {
    expect(normalizeThumbnailRequest({ url: 'jNQXAC9IVRw' })).toEqual({ input: 'jNQXAC9IVRw', format: 'jpg' });
    expect(normalizeThumbnailRequest({ url: 'x', format: 'JPEG' }).format).toBe('jpg');
    expect(normalizeThumbnailRequest({ url: 'x', format: '.png' }).format).toBe('png');
  });

  it('refuses a missing url and unknown formats', () => {
    expect(() => normalizeThumbnailRequest({})).toThrow(/Missing/);
    expect(() => normalizeThumbnailRequest({ url: 'x', format: 'gif' })).toThrow(/Unknown thumbnail format/);
  });
});

describe('burnSubtitles and splitChapters in a request', () => {
  it('passes through normalizeRequest', () => {
    const req = normalizeRequest({ url: 'x', burnSubtitles: 'en', splitChapters: '1' });
    expect(req.burnSubtitles).toBe('en');
    expect(req.splitChapters).toBe(true);
    const plain = normalizeRequest({ url: 'x' });
    expect('burnSubtitles' in plain).toBe(false);
    expect('splitChapters' in plain).toBe(false);
  });

  it('refuses burning into audio, bad codes, and splitting a trimmed download', () => {
    expect(() => normalizeRequest({ url: 'x', format: 'mp3', burnSubtitles: 'en' })).toThrow(/video files/);
    expect(() => normalizeRequest({ url: 'x', burnSubtitles: 'english!' })).toThrow(/language code/);
    expect(() => normalizeRequest({ url: 'x', splitChapters: true, from: '10' })).toThrow(/cannot be combined/);
    expect(() => normalizeExtras({ splitChapters: 'maybe' }, { kind: 'video', trimmed: false })).toThrow(/true or false/);
    expect(normalizeExtras({ splitChapters: false }, { kind: 'video', trimmed: true })).toEqual({});
  });
});

describe('chapterParts', () => {
  it('plans one part per chapter of a real YouTube video', async () => {
    const i = await info('info-youtube-jNQXAC9IVRw.json');
    const parts = chapterParts(i.chapters, i.duration);
    expect(parts.length).toBe(i.chapters?.length);
    expect(parts[0]?.fromSec).toBe(0);
    expect(parts.at(-1)?.toSec).toBeLessThanOrEqual(i.duration as number);
    for (let k = 1; k < parts.length; k++) expect(parts[k]?.fromSec).toBe(parts[k - 1]?.toSec);
  });

  it('fills missing ends from the next start, drops repeats and chapters without a start', () => {
    const parts = chapterParts(
      [{ start_time: 0, title: 'A' }, { start_time: 10, title: 'B' }, { start_time: 10.2, title: 'dup' }, { title: 'no start' }],
      30,
    );
    expect(parts.map((p) => [p.title, p.fromSec, p.toSec])).toEqual([
      ['A', 0, 10],
      ['dup', 10.2, 30],
    ]);
    expect(chapterParts([], 30)).toEqual([]);
    expect(chapterParts([{ start_time: 0 }], undefined)).toEqual([]);
  });

  it('numbers part files so they sort in order', () => {
    const safe = (s: string) => s.replace(/[/\\:]/g, '_');
    expect(partName({ index: 0, title: 'Intro: a/b', fromSec: 0, toSec: 1 }, 12, 'mp4', safe)).toBe('01 - Intro_ a_b.mp4');
    expect(partName({ index: 99, title: 'End', fromSec: 0, toSec: 1 }, 120, 'm4a', safe)).toBe('100 - End.m4a');
  });
});

describe('shiftSubtitles', () => {
  it('keeps a real SRT unchanged in content when nothing is cut', async () => {
    const srt = await readFile(SRT, 'utf8');
    const out = shiftSubtitles(srt, 0);
    const cues = srt.split(/\r?\n\r?\n/).filter((b) => b.includes('-->')).length;
    expect(out.split('\n\n').length).toBe(cues);
    expect(out.startsWith('1\n')).toBe(true);
  });

  it('moves cues to a trimmed part, clips the edges and drops the rest', async () => {
    const srt = await readFile(SRT, 'utf8');
    const out = shiftSubtitles(srt, 20, 40);
    const times = [...out.matchAll(/(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})/g)].map((m) => [
      Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
      Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000,
    ]);
    expect(times.length).toBeGreaterThan(0);
    for (const [s, e] of times) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(20);
      expect(e).toBeGreaterThan(s as number);
    }
  });

  it('reads WebVTT and strips voice tags that would show as text', () => {
    const vtt =
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.500 align:start\n<v Neil>That's one small step\n\n00:00:03.000 --> 00:00:04.000\n";
    expect(shiftSubtitles(vtt, 0)).toBe("1\n00:00:01,000 --> 00:00:02,500\nThat's one small step\n");
    expect(shiftSubtitles(vtt, 10)).toBe('');
  });
});
