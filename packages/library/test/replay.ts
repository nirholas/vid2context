/**
 * Replays the calls recorded by scripts/record-fixtures.ts through
 * replayFetch. Requests to the same URL (innertube POSTs) are told apart by
 * a key built from the request body: the client name plus the video id,
 * browse id or continuation token.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RecordedCall, type Route, replayFetch } from '@vid2context/core/testing';

export interface FixtureCall {
  method: string;
  url: string;
  key: string;
  status: number;
  contentType?: string;
  body: string;
}

export interface Fixture {
  recordedAt: string;
  playlist: string;
  calls: FixtureCall[];
}

export function requestKey(url: string, body: string): string {
  if (!body) return url;
  try {
    const j = JSON.parse(body) as {
      videoId?: string;
      browseId?: string;
      continuation?: string;
      context?: { client?: { clientName?: string } };
    };
    const client = j.context?.client?.clientName ?? '';
    return `${url} ${client} ${j.videoId ?? j.browseId ?? j.continuation ?? ''}`;
  } catch {
    return url;
  }
}

export function loadFixture(name = 'youtube-gwagon-playlist.json'): Fixture {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as Fixture;
}

export interface ReplayOptions {
  /** Called when a request starts and when its response is ready; lets tests count requests in flight. */
  around?: (call: RecordedCall, fc: FixtureCall) => Promise<void>;
}

/** A replayFetch serving the fixture. Requests that were never recorded throw. */
export function fixtureFetch(fixture: Fixture, opts: ReplayOptions = {}) {
  const byKey = new Map<string, FixtureCall>();
  for (const c of fixture.calls) byKey.set(`${c.method} ${c.key}`, c);
  const find = (call: RecordedCall) => byKey.get(`${call.method} ${requestKey(call.url, call.body ? String(call.body) : '')}`);
  const route: Route = {
    url: () => true,
    response: async (call) => {
      const fc = find(call);
      if (!fc) throw new Error(`fixture: no recorded response for ${call.method} ${call.url}`);
      await opts.around?.(call, fc);
      return { status: fc.status, body: fc.body, headers: fc.contentType ? { 'content-type': fc.contentType } : {} };
    },
  };
  return replayFetch([route]);
}
