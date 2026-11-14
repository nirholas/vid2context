import { describe, expect, it } from 'vitest';
import { errorFromResponse, isInputError, Vid2ContextError } from '../src/errors.ts';
import { decodeEntities, formatTimestamp, segmentsToText, sliceSegments, timestampUrl } from '../src/segments.ts';
import { MemoryStorage } from '../src/storage.ts';
import type { VideoContext, VideoRef } from '../src/types.ts';

describe('errorFromResponse', () => {
  it('maps HTTP statuses to stable codes and reads Retry-After', async () => {
    const limited = await errorFromResponse(new Response('quota', { status: 429, headers: { 'retry-after': '12' } }), 'groq');
    expect(limited).toMatchObject({ code: 'rate-limited', status: 429, retryAfterSec: 12 });
    expect(limited.message).toBe('groq: HTTP 429 quota');
    expect((await errorFromResponse(new Response('', { status: 401 }), 'x')).code).toBe('auth');
    expect((await errorFromResponse(new Response('', { status: 410 }), 'x')).code).toBe('not-found');
    expect((await errorFromResponse(new Response('', { status: 413 }), 'x')).code).toBe('too-large');
    expect((await errorFromResponse(new Response('', { status: 503 }), 'x')).code).toBe('upstream');
  });

  it('treats only caller errors as input errors', () => {
    expect(isInputError(new Vid2ContextError('bad-request', 'x'))).toBe(true);
    expect(isInputError(new Vid2ContextError('upstream', 'x'))).toBe(false);
    expect(isInputError(new Error('x'))).toBe(false);
  });
});

describe('segments', () => {
  const ref: VideoRef = {
    input: 'jNQXAC9IVRw',
    platform: 'youtube',
    kind: 'video',
    id: 'youtube:jNQXAC9IVRw',
    nativeId: 'jNQXAC9IVRw',
  };

  it('formats timestamps', () => {
    expect(formatTimestamp(75)).toBe('1:15');
    expect(formatTimestamp(3723)).toBe('1:02:03');
    expect(formatTimestamp(5, true)).toBe('0:00:05');
  });

  it('builds deep links per platform', () => {
    expect(timestampUrl(ref, 12.7)).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s');
    expect(timestampUrl({ ...ref, platform: 'vimeo', url: 'https://vimeo.com/76979871' }, 30)).toBe(
      'https://vimeo.com/76979871#t=30s',
    );
    expect(timestampUrl({ ...ref, platform: 'file', url: undefined }, 30)).toBeUndefined();
  });

  it('decodes caption entities and joins text', () => {
    expect(decodeEntities('it&#39;s &amp; &quot;fine&quot; &#x2014;')).toBe('it\'s & "fine" \u2014');
    const segs = [
      { startSec: 0, endSec: 2, text: ' All right, so here ' },
      { startSec: 2, endSec: 5, text: 'we are\n in front of the elephants' },
    ];
    expect(segmentsToText(segs)).toBe('All right, so here we are in front of the elephants');
    expect(sliceSegments(segs, 2, 3)).toEqual([segs[1]]);
  });
});

describe('MemoryStorage', () => {
  const context: VideoContext = {
    metadata: {
      ref: { input: 'jNQXAC9IVRw', platform: 'youtube', kind: 'video', id: 'youtube:jNQXAC9IVRw', nativeId: 'jNQXAC9IVRw' },
      title: 'Me at the zoo',
      chapters: [],
    },
    transcript: {
      ref: { input: 'jNQXAC9IVRw', platform: 'youtube', kind: 'video', id: 'youtube:jNQXAC9IVRw', nativeId: 'jNQXAC9IVRw' },
      language: 'en',
      origin: 'creator-captions',
      producer: 'youtube',
      segments: [
        { startSec: 1.2, endSec: 2.16, text: 'All right, so here we are,' },
        { startSec: 2.16, endSec: 4.12, text: 'in front of the elephants' },
      ],
      createdAt: '2026-11-14T00:00:00.000Z',
    },
    attempts: [],
  };

  it('saves, lists, searches and deletes contexts', async () => {
    const s = new MemoryStorage();
    await s.putContext(context);
    expect((await s.getContext('youtube:jNQXAC9IVRw'))?.metadata.title).toBe('Me at the zoo');
    expect((await s.listContexts()).items.map((i) => i.id)).toEqual(['youtube:jNQXAC9IVRw']);
    const hits = await s.search({ text: 'elephants' });
    expect(hits[0]).toMatchObject({ videoId: 'youtube:jNQXAC9IVRw', startSec: 2.16 });
    await s.deleteContext('youtube:jNQXAC9IVRw');
    expect(await s.getContext('youtube:jNQXAC9IVRw')).toBeNull();
  });

  it('manages collections and reports unknown ids as not-found', async () => {
    const s = new MemoryStorage();
    const c = await s.createCollection({ name: 'G-Wagon research' });
    expect(c.id).toMatch(/^g-wagon-research-[0-9a-f]{8}$/);
    await s.addToCollection(c.id, ['youtube:jNQXAC9IVRw', 'youtube:jNQXAC9IVRw']);
    expect((await s.getCollection(c.id))?.videoIds).toEqual(['youtube:jNQXAC9IVRw']);
    await expect(s.addToCollection('missing', [])).rejects.toMatchObject({ code: 'not-found' });
  });
});
