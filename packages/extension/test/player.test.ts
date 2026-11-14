import { describe, expect, it } from 'vitest';
import { captionTracks, defaultTrackIndex, extractPlayerResponse, objectAt } from '../src/youtube/player.ts';
import { fixture } from './helpers.ts';

describe('extractPlayerResponse on recorded watch pages', () => {
  const zoo = fixture('watch-jNQXAC9IVRw.html');

  it('finds the player response for the page video', () => {
    const p = extractPlayerResponse(zoo, 'jNQXAC9IVRw');
    expect(p?.videoDetails?.title).toBe('Me at the zoo');
    expect(p?.videoDetails?.author).toBe('jawed');
    expect(p?.playabilityStatus?.status).toBe('OK');
    expect(captionTracks(p ?? {}).map((t) => t.languageCode)).toEqual(['en', 'de']);
    expect(defaultTrackIndex(p ?? {})).toBe(0);
  });

  it('works without a video id and refuses a response for another video', () => {
    expect(extractPlayerResponse(zoo)?.videoDetails?.videoId).toBe('jNQXAC9IVRw');
    expect(extractPlayerResponse(zoo, 'brXcsLhw84o')).toBeNull();
  });

  it('reads a video without captions', () => {
    const p = extractPlayerResponse(fixture('watch-nocaptions-brXcsLhw84o.html'), 'brXcsLhw84o');
    expect(p?.videoDetails?.title).toContain('Piano');
    expect(captionTracks(p ?? {})).toEqual([]);
  });

  it('returns null for HTML without a player response', () => {
    expect(extractPlayerResponse(fixture('timedtext-jNQXAC9IVRw-en-429.html'))).toBeNull();
  });
});

describe('objectAt', () => {
  it('keeps braces and escaped quotes inside strings', () => {
    const page = fixture('watch-jNQXAC9IVRw.html');
    const start = page.indexOf('{', page.indexOf('ytInitialPlayerResponse'));
    const json = objectAt(page, start);
    expect(json && JSON.parse(json).videoDetails.videoId).toBe('jNQXAC9IVRw');
  });

  it('returns null when the object never closes or does not start at a brace', () => {
    const page = fixture('watch-jNQXAC9IVRw.html');
    const start = page.indexOf('{', page.indexOf('ytInitialPlayerResponse'));
    expect(objectAt(page.slice(0, start + 500), start)).toBeNull();
    expect(objectAt(page, start - 1)).toBeNull();
  });
});
