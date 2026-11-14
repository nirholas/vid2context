import { Vid2ContextError } from '@vid2context/core';
import { replayFetch } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { fetchCaptionSegments, poTokenFromUrl, trackUrl } from '../src/youtube/captions.ts';
import { pickTrack } from '../src/youtube/context.ts';
import { fixture, zooPlayer } from './helpers.ts';

const track = (() => {
  const choice = pickTrack(zooPlayer());
  if (!choice) throw new Error('fixture has no track');
  return choice.track;
})();

const noToken = async () => null;

describe('trackUrl and poTokenFromUrl on the recorded track URL', () => {
  it('sets the format and keeps the signed parameters', () => {
    const u = new URL(trackUrl(track.baseUrl, { fmt: 'srv3' }));
    const base = new URL(track.baseUrl);
    expect(u.searchParams.get('fmt')).toBe('srv3');
    expect(u.searchParams.get('signature')).toBe(base.searchParams.get('signature'));
    expect(u.searchParams.get('lang')).toBe('en');
    expect(new URL(trackUrl(u.href, {})).searchParams.has('fmt')).toBe(false);
  });

  it('finds no token in a watch-page track URL (only the player adds one)', () => {
    expect(poTokenFromUrl(track.baseUrl, 'jNQXAC9IVRw')).toBeNull();
    expect(poTokenFromUrl('not a url', 'jNQXAC9IVRw')).toBeNull();
  });
});

describe('fetchCaptionSegments', () => {
  it('downloads srv3 from youtube.com and parses it with the provider parser', async () => {
    const fetch = replayFetch([
      { url: /\/api\/timedtext\?.*fmt=srv3/, response: { body: fixture('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    ]);
    const { segments, usedPoToken } = await fetchCaptionSegments(track, { fetch, getPoToken: noToken });
    expect(usedPoToken).toBe(false);
    expect(segments).toHaveLength(6);
    expect(segments.at(-1)?.text).toBe("and that's pretty much all there is to say");
    expect(fetch.calls).toHaveLength(1);
    expect(new URL(fetch.calls[0]?.url ?? '').origin).toBe('https://www.youtube.com');
  });

  it('reports YouTube\'s "automated queries" refusal as blocked, with a way forward', async () => {
    const fetch = replayFetch([
      { url: /\/api\/timedtext/, response: { status: 429, body: fixture('timedtext-jNQXAC9IVRw-en-429.html') } },
    ]);
    const err = await fetchCaptionSegments(track, { fetch, getPoToken: noToken }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('blocked');
    expect((err as Vid2ContextError).status).toBe(429);
    expect((err as Vid2ContextError).hint).toContain('Open in vid2context');
  });
});
