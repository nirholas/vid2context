/**
 * Shared test setup: a registry with the real YouTube provider and a
 * replayFetch serving responses recorded from YouTube (the provider's own
 * fixtures plus this package's playlist fixtures, see fixtures/README.md).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ctx, type Env, Registry } from '@vid2context/core';
import { type RecordedCall, type RecordedResponse, type Route, replayFetch, testContext } from '@vid2context/core/testing';
import youtube, { resetBreaker } from '@vid2context/provider-youtube';
import type { JobEventRecord, JobQueue } from '../src/index.ts';

const here = import.meta.dirname;
const ytDir = join(here, '..', '..', '..', 'providers', 'youtube', 'test', 'fixtures');

export const ytFixture = (name: string): string => readFileSync(join(ytDir, name), 'utf8');
export const jobsFixture = (name: string): string => readFileSync(join(here, 'fixtures', name), 'utf8');

export const PLAYLIST = 'https://www.youtube.com/playlist?list=PLDWrj3hS12VU';
export const PLAYLIST_FIRST3 = ['youtube:jNQXAC9IVRw', 'youtube:Ay22n7jR2j4', 'youtube:cBsRvPSWXQk'];

const JSON_HEADERS = { 'content-type': 'application/json' };

function playerFor(videoId: string): RecordedResponse {
  if (videoId === 'jNQXAC9IVRw' || videoId === 'cCPsdFdlshc')
    return { body: ytFixture(`player-${videoId}.json`), headers: JSON_HEADERS };
  if (videoId === 'Ay22n7jR2j4' || videoId === 'cBsRvPSWXQk')
    return { body: jobsFixture(`player-${videoId}.json`), headers: JSON_HEADERS };
  return { body: ytFixture('player-unavailable.json'), headers: JSON_HEADERS };
}

export interface ReplayOptions {
  /** Called before each player response; await something here to hold a request open. */
  beforePlayer?: (videoId: string) => Promise<void> | void;
}

/** Routes for every YouTube call the tests make, all answered from recordings. */
export function youtubeRoutes(opts: ReplayOptions = {}): Route[] {
  return [
    {
      method: 'POST',
      url: /youtubei\/v1\/player/,
      response: async (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        await opts.beforePlayer?.(videoId);
        return playerFor(videoId);
      },
    },
    {
      method: 'POST',
      url: /youtubei\/v1\/browse/,
      response: (call: RecordedCall) => {
        const body = JSON.parse(String(call.body)) as { browseId?: string };
        if (body.browseId === 'VLPLDWrj3hS12VU')
          return { body: jobsFixture('browse-playlist-PLDWrj3hS12VU.json'), headers: JSON_HEADERS };
        throw new Error(`no recorded browse response for ${String(call.body).slice(0, 120)}`);
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en/, response: { body: ytFixture('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=de/, response: { body: ytFixture('timedtext-jNQXAC9IVRw-de.srv3.xml') } },
    { url: /timedtext\?v=cCPsdFdlshc.*tlang=/, response: { status: 429, body: ytFixture('timedtext-429-blocked.html') } },
    { url: /timedtext\?v=cCPsdFdlshc/, response: { body: ytFixture('timedtext-cCPsdFdlshc-en-asr.srv3.xml') } },
    { url: /timedtext\?v=cBsRvPSWXQk/, response: { status: 429, body: jobsFixture('timedtext-cBsRvPSWXQk-en-asr-429.html') } },
  ];
}

export function youtubeRegistry(): Registry {
  return new Registry(youtube, 'node');
}

/** A test Ctx on a fresh env object (the provider caches per env) with recorded YouTube responses. */
export function youtubeCtx(opts: ReplayOptions & { env?: Env } = {}): Ctx & { fetch: ReturnType<typeof replayFetch> } {
  resetBreaker();
  const fetch = replayFetch(youtubeRoutes(opts));
  return testContext({ env: { ...opts.env }, fetch }) as Ctx & { fetch: ReturnType<typeof replayFetch> };
}

/** Collect every event of a job until it ends. Resolves with the events. */
export function collect(queue: JobQueue, id: string): { events: JobEventRecord[]; done: Promise<JobEventRecord[]> } {
  const events: JobEventRecord[] = [];
  const done = new Promise<JobEventRecord[]>((resolve) => {
    const off = queue.subscribe(id, (e) => {
      events.push(e);
      if (e.type === 'done' || e.type === 'error') {
        off();
        resolve(events);
      }
    });
  });
  return { events, done };
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A promise you resolve from outside. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}
