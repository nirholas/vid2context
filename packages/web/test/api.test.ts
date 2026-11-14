import type { VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { apiUrl, getContext, getHealth, getItems, isListError, normalizeApiBase } from '../src/lib/api.ts';
import type { AppError } from '../src/lib/errors.ts';
import { contextViaJob, type JobProgress, parseSse } from '../src/lib/jobs.ts';
import { BASE, recorded, replay } from './helpers.ts';

const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const MISSING = 'https://www.youtube.com/watch?v=xxxxxxxxxxx';
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';

describe('API client', () => {
  it('builds URLs without empty parameters', () => {
    expect(apiUrl('/context', { url: VIDEO, mode: undefined, lang: '' }, BASE)).toBe(
      `${BASE}/context?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw`,
    );
    expect(normalizeApiBase(' http://x/api/v1/// ')).toBe('http://x/api/v1');
  });

  it('reads health from a real server', async () => {
    const h = await getHealth({ base: BASE, fetch: replay('health.json') });
    expect(h.name).toBe('vid2context');
    expect(h.formats.map((f) => f.id)).toContain('text');
  });

  it('gets a VideoContext', async () => {
    const c = await getContext(VIDEO, {}, { base: BASE, fetch: replay('context-jNQXAC9IVRw.json') });
    expect(c.metadata.title).toBe('Me at the zoo');
    expect(c.transcript.segments.length).toBeGreaterThan(0);
  });

  it('recognizes a playlist given to /context, then expands it with /items', async () => {
    const fetch = replay('context-playlist.json', 'items-playlist.json');
    const err = await getContext(PLAYLIST, {}, { base: BASE, fetch }).catch((e) => e);
    expect(isListError(err)).toBe(true);
    const items = await getItems(PLAYLIST, { base: BASE, fetch }, 3);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((r) => r.kind === 'video' && r.url?.startsWith('https://www.youtube.com/watch?v='))).toBe(true);
  });

  it('does not mistake other input errors for lists', async () => {
    const err = await getContext(MISSING, {}, { base: BASE, fetch: replay('context-not-found.json') }).catch((e) => e);
    expect(isListError(err)).toBe(false);
  });
});

describe('jobs', () => {
  it('parses a recorded event stream', async () => {
    const body = recorded('job-context-events.json').body as string;
    const events = [];
    for await (const e of parseSse(new Response(body).body as ReadableStream<Uint8Array>)) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('done');
    expect(JSON.parse(events[0]?.data ?? '{}').result.video.title).toBe('Me at the zoo');
  });

  it('runs a context job, follows its events, then reads the saved context', async () => {
    const fetch = replay('job-context.json', 'job-context-events.json', 'context-jNQXAC9IVRw.json');
    const progress: JobProgress[] = [];
    const c: VideoContext = await contextViaJob(VIDEO, {}, (p) => progress.push(p), { base: BASE, fetch });
    expect(c.metadata.ref.id).toBe('youtube:jNQXAC9IVRw');
    expect(fetch.calls.map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual([
      'POST /api/v1/jobs',
      `GET /api/v1/jobs/${(recorded('job-context.json').body as { id: string }).id}/events`,
      'GET /api/v1/context',
    ]);
    expect(JSON.parse(String(fetch.calls[0]?.body))).toEqual({ kind: 'context', input: VIDEO, options: {} });
  });

  it('shows a failed job with the attempts from a direct call', async () => {
    const fetch = replay('job-not-found.json', 'job-not-found-events.json', 'context-not-found.json');
    const err = (await contextViaJob(MISSING, {}, () => undefined, { base: BASE, fetch }).catch((e) => e)) as AppError;
    expect(err.code).toBe('not-found');
    expect(err.hint).toBe('The video does not exist or was removed. Check the video id or URL.');
    expect(err.attempts.length).toBe(2);
    expect(fetch.calls.map((x) => x.method)).toEqual(['POST', 'GET', 'GET']);
  });
});
