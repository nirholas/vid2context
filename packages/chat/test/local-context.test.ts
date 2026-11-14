import { render } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { contextFromPaste, parseClock, parseContextJson, parseTranscriptText } from '../src/lib/local-context.ts';
import { sharedContext, sharedContextText } from './helpers.ts';

describe('dropping vid2context JSON', () => {
  it('reads the real VideoContext output', () => {
    const [ctx] = parseContextJson(sharedContextText('cCPsdFdlshc'), 'video.json');
    expect(ctx?.metadata.ref.id).toBe('youtube:cCPsdFdlshc');
    expect(ctx?.transcript.segments.length).toBe(521);
  });

  it('reads several contexts from an array', () => {
    const both = `[${sharedContextText('cCPsdFdlshc')},${sharedContextText('jNQXAC9IVRw')}]`;
    expect(parseContextJson(both).map((c) => c.metadata.ref.id)).toEqual(['youtube:cCPsdFdlshc', 'youtube:jNQXAC9IVRw']);
  });

  it('explains what is wrong with other files', () => {
    expect(() => parseContextJson('not json', 'notes.txt')).toThrow(/not valid JSON/);
    expect(() => parseContextJson('{"title":"x"}', 'other.json')).toThrow(/does not contain a vid2context VideoContext/);
  });
});

describe('pasting a transcript', () => {
  const ctx = sharedContext('jNQXAC9IVRw');

  it('parses SRT and WebVTT that vid2context itself writes, keeping the timing', () => {
    for (const format of ['srt', 'vtt']) {
      const segments = parseTranscriptText(render(ctx, format));
      expect(segments.length, format).toBeGreaterThan(0);
      expect(segments[0]?.startSec, format).toBeCloseTo(ctx.transcript.segments[0]?.startSec ?? 0, 0);
      expect(segments.map((s) => s.text).join(' ')).toContain('elephants');
    }
  });

  it('parses "[m:ss] text" lines from the text format with timestamps', () => {
    const segments = parseTranscriptText(render(ctx, 'text', { timestamps: true }));
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s, i) => i === 0 || s.startSec >= (segments[i - 1]?.startSec ?? 0))).toBe(true);
  });

  it('builds a youtube ref from the link so citations open the video', () => {
    const pasted = contextFromPaste({ title: 'Me at the zoo', url: 'https://youtu.be/jNQXAC9IVRw', text: render(ctx, 'srt') });
    expect(pasted.metadata.ref).toMatchObject({ platform: 'youtube', id: 'youtube:jNQXAC9IVRw', nativeId: 'jNQXAC9IVRw' });
    expect(pasted.transcript.origin).toBe('native-transcript');
  });

  it('refuses text without timestamps, with a hint', () => {
    expect(() => contextFromPaste({ title: 't', text: ctx.transcript.segments.map((s) => s.text).join(' ') })).toThrow(
      /No timestamps/,
    );
  });

  it('reads clock formats', () => {
    expect(parseClock('1:15')).toBe(75);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('00:00:01,500')).toBe(1.5);
    expect(parseClock('nope')).toBeUndefined();
  });
});
