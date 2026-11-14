import { describe, expect, it } from 'vitest';
import { pickTrack } from '../src/youtube/context.ts';
import { extractPlayerResponse } from '../src/youtube/player.ts';
import { fixture, zooContext, zooPlayer } from './helpers.ts';

describe('track choice (the YouTube provider chooseTrack, fed from the page)', () => {
  it('picks the creator track in the spoken language', () => {
    const choice = pickTrack(zooPlayer());
    expect(choice?.track.languageCode).toBe('en');
    expect(choice?.origin).toBe('creator-captions');
    expect(choice?.translateTo).toBeUndefined();
  });

  it('honours a requested language', () => {
    expect(pickTrack(zooPlayer(), 'de')?.track.languageCode).toBe('de');
  });

  it('returns null when the video has no captions', () => {
    const p = extractPlayerResponse(fixture('watch-nocaptions-brXcsLhw84o.html'), 'brXcsLhw84o');
    expect(p && pickTrack(p)).toBeNull();
  });
});

describe('buildVideoContext', () => {
  const c = zooContext();

  it('takes metadata from videoDetails and microformat', () => {
    expect(c.metadata.ref).toEqual({
      input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      platform: 'youtube',
      kind: 'video',
      id: 'youtube:jNQXAC9IVRw',
      nativeId: 'jNQXAC9IVRw',
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    });
    expect(c.metadata.title).toBe('Me at the zoo');
    expect(c.metadata.channel).toEqual({
      name: 'jawed',
      id: 'UC4QobU6STFB0P71PMvOGN5A',
      url: 'https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A',
    });
    expect(c.metadata.durationSec).toBe(19);
    expect(c.metadata.publishedAt).toBe('2005-04-24T03:31:52.000Z');
    expect(c.metadata.thumbnailUrl).toMatch(/^https:\/\/i\.ytimg\.com\/vi\/jNQXAC9IVRw\//);
  });

  it('parses chapters from the description', () => {
    expect(c.metadata.chapters).toEqual([
      { title: 'Intro', startSec: 0, endSec: 5 },
      { title: 'The cool thing', startSec: 5, endSec: 17 },
      { title: 'End', startSec: 17, endSec: 19 },
    ]);
  });

  it('keeps the raw caption segments and says where they came from', () => {
    expect(c.transcript.origin).toBe('creator-captions');
    expect(c.transcript.language).toBe('en');
    expect(c.transcript.producer).toBe('youtube-captions');
    expect(c.transcript.createdAt).toBe('2026-11-14T17:00:00.000Z');
    expect(c.transcript.segments).toHaveLength(6);
    expect(c.transcript.segments[0]).toEqual({
      startSec: 1.2,
      endSec: 3.36,
      text: 'All right, so here we are, in front of the elephants',
    });
    expect(c.attempts).toEqual([expect.objectContaining({ id: 'youtube-captions', stage: 'captions', outcome: 'ok' })]);
  });
});
