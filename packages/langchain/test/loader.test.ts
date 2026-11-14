import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '@langchain/core/documents';
import { replayFetch } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { chunkContext, errorFromBody, fetchContext, Vid2ContextApiError, VideoContextLoader } from '../src/index.ts';

// Real responses recorded from a running vid2context server; see clients/python/tests/fixtures/README.md.
const dir = join(import.meta.dirname, '../../../clients/python/tests/fixtures');

interface Recording {
  request: { method: string; path: string; query: Record<string, string> };
  status: number;
  headers: Record<string, string>;
  body: string;
}

const load = (name: string): Recording => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
// context-blocked has the same request as context-jNQXAC9IVRw; error tests read it by name.
const served = readdirSync(dir)
  .filter((f) => f.endsWith('.json') && f !== 'context-blocked.json')
  .map((f) => load(f.slice(0, -5)));

const sameQuery = (url: URL, query: Record<string, string>) =>
  JSON.stringify(Object.fromEntries([...url.searchParams].sort())) ===
  JSON.stringify(Object.fromEntries(Object.entries(query).sort()));

const server = () =>
  replayFetch(
    served.map((rec) => ({
      method: rec.request.method,
      url: (url: URL) => url.pathname === rec.request.path && sameQuery(url, rec.request.query),
      response: { status: rec.status, headers: rec.headers, body: rec.body },
    })),
  );

const ZOO = 'https://youtu.be/jNQXAC9IVRw';
const GWAGON = 'https://www.youtube.com/watch?v=cCPsdFdlshc';

describe('VideoContextLoader', () => {
  it('loads chapter Documents with timestamp metadata', async () => {
    const fetch = server();
    const docs = await new VideoContextLoader(ZOO, { fetch, baseUrl: 'http://127.0.0.1:8787' }).load();
    expect(fetch.calls[0]?.url).toBe('http://127.0.0.1:8787/api/v1/context?url=https%3A%2F%2Fyoutu.be%2FjNQXAC9IVRw');
    expect(fetch.calls[0]?.headers.authorization).toBeUndefined();
    expect(docs.every((d) => d instanceof Document)).toBe(true);
    // The last caption starts at 16.881 s, before the "End" chapter, so "End" has no text.
    expect(docs.map((d) => d.metadata.chapter)).toEqual(['Intro', 'The cool thing']);
    expect(docs[0]?.id).toBe('youtube:jNQXAC9IVRw#chapters-0');
    expect(docs[0]?.pageContent).toBe('All right, so here we are, in front of the elephants');
    expect(docs[0]?.metadata).toEqual({
      source: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      title: 'Me at the zoo',
      channel: 'jawed',
      video_id: 'youtube:jNQXAC9IVRw',
      platform: 'youtube',
      transcript_origin: 'creator-captions',
      language: 'en',
      start_sec: 0,
      end_sec: 5,
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s',
      chunking: 'chapters',
      chapter: 'Intro',
      chapter_index: 0,
    });
    expect(docs[1]?.metadata.url).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s');
  });

  it('falls back to windows for a video without chapters and covers the whole transcript', async () => {
    const docs = await new VideoContextLoader(GWAGON, { fetch: server() }).load();
    expect(docs.length).toBeGreaterThanOrEqual(17);
    expect(docs.length).toBeLessThanOrEqual(20);
    expect(docs.every((d) => d.metadata.chunking === 'window' && d.metadata.chunking_requested === 'chapters')).toBe(true);
    const ctx = JSON.parse(load('context-cCPsdFdlshc').body);
    const all = ctx.transcript.segments
      .map((s: { text: string }) => s.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(docs.map((d) => d.pageContent).join(' ')).toBe(all);
    for (const d of docs)
      expect(d.metadata.url).toBe(`https://www.youtube.com/watch?v=cCPsdFdlshc&t=${Math.floor(Number(d.metadata.start_sec))}s`);
  });

  it('chunks by segments and by window, with the same results as the Python client', async () => {
    const fetch = server();
    const segs = await new VideoContextLoader(ZOO, { fetch, chunking: 'segments' }).load();
    expect(segs).toHaveLength(6);
    expect(segs[3]?.pageContent).toBe("and that's cool");
    expect(segs[0]?.metadata).toMatchObject({
      start_sec: 1.2,
      end_sec: 3.36,
      segment_index: 0,
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s',
    });
    const windows = await new VideoContextLoader(GWAGON, { fetch, chunking: 'window', windowSec: 300 }).load();
    expect(windows.length).toBeGreaterThanOrEqual(4);
    expect(windows.length).toBeLessThanOrEqual(5);
    for (const [i, w] of windows.entries()) expect(w.metadata.window_index).toBe(i);
    for (let i = 1; i < windows.length; i++) {
      expect(Number(windows[i]?.metadata.start_sec)).toBeGreaterThanOrEqual(Number(windows[i - 1]?.metadata.start_sec) + 300);
    }
  });

  it('points file media without a deep-link form at the file itself', async () => {
    const docs = await new VideoContextLoader('tests/fixtures/media/apollo11-small-step.mp3', {
      fetch: server(),
      chunking: 'window',
      windowSec: 10,
    }).load();
    expect(docs.map((d) => d.pageContent)).toEqual([
      "I'm going to step off the limb now.",
      "That's one small step for man, one giant leap for mankind.",
    ]);
    const meta = docs[1]?.metadata;
    expect(meta).toMatchObject({ platform: 'file', transcript_origin: 'stt', start_sec: 14.98, end_sec: 23.04 });
    expect(meta?.url).toBe(meta?.source);
    expect(String(meta?.url).startsWith('file://')).toBe(true);
    expect(meta && 'channel' in meta).toBe(false);
  });

  it('lazyLoad fetches one video at a time and sends the API key', async () => {
    const fetch = server();
    const it = new VideoContextLoader([ZOO, GWAGON], {
      fetch,
      apiKey: 'k1',
      baseUrl: 'http://127.0.0.1:8787/api/v1/',
    }).lazyLoad();
    const first = await it.next();
    expect(first.value?.metadata.video_id).toBe('youtube:jNQXAC9IVRw');
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.headers.authorization).toBe('Bearer k1');
    const rest = [];
    for await (const d of it) rest.push(d);
    expect(fetch.calls.map((c) => new URL(c.url).searchParams.get('url'))).toEqual([ZOO, GWAGON]);
    expect(rest.at(-1)?.metadata.video_id).toBe('youtube:cCPsdFdlshc');
  });

  it('throws the server error with code, hint and attempts', async () => {
    const err = await new VideoContextLoader(['xxxxxxxxxxx', ZOO], { fetch: server() }).load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextApiError);
    const e = err as Vid2ContextApiError;
    expect(e.code).toBe('not-found');
    expect(e.status).toBe(404);
    expect(e.hint).toBe('Check the video id or URL; the video may have been removed.');
    expect(e.attempts.map((a) => [a.stage, a.outcome])).toEqual([
      ['resolve', 'ok'],
      ['metadata', 'error'],
    ]);
  });

  it('skips failed videos when continueOnFailure is set', async () => {
    const skipped: string[] = [];
    const docs = await new VideoContextLoader(['xxxxxxxxxxx', ZOO], {
      fetch: server(),
      continueOnFailure: true,
      onSkip: (url, e) => skipped.push(`${url} ${e.code}`),
    }).load();
    expect(skipped).toEqual(['xxxxxxxxxxx not-found']);
    expect(new Set(docs.map((d) => d.metadata.video_id))).toEqual(new Set(['youtube:jNQXAC9IVRw']));
  });

  it('checks options up front', () => {
    expect(() => new VideoContextLoader([])).toThrow('No video URLs');
    expect(() => new VideoContextLoader(ZOO, { chunking: 'pages' as 'window' })).toThrow('Unknown chunking');
    expect(() => new VideoContextLoader(ZOO, { windowSec: 0 })).toThrow('windowSec must be positive');
  });
});

describe('error bodies', () => {
  it('keeps every attempt when YouTube blocks the machine', () => {
    const rec = load('context-blocked');
    const e = errorFromBody(rec.status, rec.body);
    expect([e.code, e.status]).toEqual(['no-transcript', 422]);
    expect(e.attempts.find((a) => a.id === 'youtube-captions')?.reason).toBe('blocked');
  });

  it('parses bodies without hint or attempts, and bodies that are not the contract', () => {
    const missing = load('transcript-missing-url');
    expect(errorFromBody(missing.status, missing.body)).toMatchObject({ code: 'bad-request', hint: 'Pass ?url=<video URL>.' });
    const health = load('health');
    const notContract = errorFromBody(502, health.body);
    expect([notContract.code, notContract.serverCode, notContract.status]).toEqual(['upstream', 'upstream', 502]);
    expect(notContract.hint).toContain('/api/v1/health');
  });

  it('reports an unreachable server with a hint to start it', async () => {
    // Port 1 on loopback is never a vid2context server; the connection is refused locally.
    const err = await fetchContext(ZOO, { baseUrl: 'http://127.0.0.1:1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextApiError);
    expect((err as Vid2ContextApiError).hint).toContain('npm run start:server');
  });
});

describe('chunkContext', () => {
  it('rejects unknown modes', () => {
    const ctx = JSON.parse(load('context-jNQXAC9IVRw').body);
    expect(() => chunkContext(ctx, 'pages' as 'window')).toThrow('Unknown chunking "pages".');
    try {
      chunkContext(ctx, 'pages' as 'window');
    } catch (e) {
      expect((e as Vid2ContextApiError).hint).toBe('Use one of: chapters, segments, window.');
    }
  });
});
