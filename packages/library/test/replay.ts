/**
 * Replays the calls recorded by scripts/record-fixtures.ts through
 * replayFetch. Requests to the same URL (innertube POSTs) are told apart by
 * a key built from the request body: the client name plus the video id,
 * browse id or continuation token.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RecordedCall, type RecordedResponse, replayFetch } from '@vid2context/core/testing';

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

export const fixturePath = (name: string) => join(import.meta.dirname, 'fixtures', name);
export const readFixture = (name: string) => readFileSync(fixturePath(name), 'utf8');

export function loadFixture(name = 'youtube-gwagon-playlist.json'): Fixture {
  return JSON.parse(readFixture(name)) as Fixture;
}

export interface Override {
  match: (call: RecordedCall) => boolean;
  response: RecordedResponse;
}

export interface ReplayOptions {
  /** Checked before the recorded calls. */
  overrides?: Override[];
  /** Runs before each response is returned; lets tests count requests in flight. */
  around?: (call: RecordedCall) => Promise<void>;
}

/** A replayFetch serving the fixture. Requests that were never recorded throw. */
export function fixtureFetch(fixture: Fixture, opts: ReplayOptions = {}) {
  const byKey = new Map<string, FixtureCall>();
  for (const c of fixture.calls) byKey.set(`${c.method} ${c.key}`, c);
  return replayFetch([
    {
      url: () => true,
      response: async (call) => {
        await opts.around?.(call);
        const o = opts.overrides?.find((x) => x.match(call));
        if (o) return o.response;
        const fc = byKey.get(`${call.method} ${requestKey(call.url, call.body ? String(call.body) : '')}`);
        if (!fc) throw new Error(`fixture: no recorded response for ${call.method} ${call.url}`);
        return { status: fc.status, body: fc.body, headers: fc.contentType ? { 'content-type': fc.contentType } : {} };
      },
    },
  ]);
}

const PLAYER = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const playerFor =
  (id: string) =>
  (call: RecordedCall): boolean =>
    call.url === PLAYER && String(call.body).includes(`"videoId":"${id}"`);
const json = { 'content-type': 'application/json' };

/**
 * Videos with working captions, recorded on 2026-11-14 for the YouTube
 * provider's tests and copied here: "Best & Worst G-Wagon Years" (in the
 * playlist) and "Me at the zoo".
 */
export const captionedVideos: Override[] = [
  { match: playerFor('cCPsdFdlshc'), response: { body: readFixture('player-cCPsdFdlshc.json'), headers: json } },
  {
    match: (c) => /\/api\/timedtext\?v=cCPsdFdlshc.*lang=en.*fmt=srv3/.test(c.url) && !c.url.includes('tlang='),
    response: { body: readFixture('timedtext-cCPsdFdlshc-en-asr.srv3.xml') },
  },
  { match: playerFor('jNQXAC9IVRw'), response: { body: readFixture('player-jNQXAC9IVRw.json'), headers: json } },
  {
    match: (c) => /\/api\/timedtext\?v=jNQXAC9IVRw.*lang=en.*fmt=srv3/.test(c.url) && !c.url.includes('tlang='),
    response: { body: readFixture('timedtext-jNQXAC9IVRw-en.srv3.xml') },
  },
];
