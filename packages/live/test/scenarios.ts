/**
 * Shared by the replay tests and by scripts/record-stt.ts: the HLS routes
 * that serve the recorded fixtures, and the watcher runs whose
 * speech-to-text responses are recorded once (LIVE) and replayed in tests.
 * Running a scenario with the recorder and with the replayer sends exactly
 * the same chunk audio, so every replayed response belongs to its request.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ctx, Registry } from '@vid2context/core';
import { type RecordedCall, type RecordedResponse, type Route, replayFetch, testContext } from '@vid2context/core/testing';
import stt from '@vid2context/provider-stt-openai-compatible';
import { createFfmpegExtractor } from '../src/ffmpeg.ts';
import type { LiveEvent, WatchLiveOptions } from '../src/types.ts';
import { abortableSleep, watchLive } from '../src/watch.ts';

export const FIXTURES = join(import.meta.dirname, 'fixtures');
const NASA = join(FIXTURES, 'nasa-iss');
const APOLLO = join(FIXTURES, 'apollo-hls');

export const NASA_VIDEO = 'M3HKLzjvKPc';
export const NASA_URL = `https://www.youtube.com/watch?v=${NASA_VIDEO}`;
/** The three recorded segments: the last of media-1.m3u8 and the two that media-2.m3u8 adds. */
export const NASA_SEGMENTS = [323509, 323510, 323511];
/** Where the Apollo fixtures are served in tests, as `npx http-server` or any static server would serve the folder. */
export const APOLLO_URL = 'http://localhost:8000/apollo/live.m3u8';
export const APOLLO_STATES = 7;
export const OVH_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions';

export const read = (p: string) => readFileSync(p, 'utf8');
const bytes = (p: string) => new Uint8Array(readFileSync(p));

/** Answers speech-to-text requests: from a recording in tests, from the real service when recording. */
export type SttResponder = (call: RecordedCall) => Promise<RecordedResponse>;

/** Replays the responses recorded for a scenario, in order. */
export function replayStt(name: string): SttResponder & { served: () => number } {
  const file = join(FIXTURES, 'stt', `${name}.json`);
  const recorded = existsSync(file) ? (JSON.parse(read(file)) as RecordedResponse[]) : [];
  let i = 0;
  const fn = async () => {
    const r = recorded[i++];
    if (!r) throw new Error(`no recorded speech-to-text response #${i} for scenario ${name}`);
    return r;
  };
  return Object.assign(fn, { served: () => i });
}

/** YouTube player, master and media playlists and segments from test/fixtures/nasa-iss. media-1 first, then media-2. */
export function nasaRoutes(): Route[] {
  let mediaCalls = 0;
  return [
    {
      method: 'POST',
      url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      response: (call) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        if (videoId === NASA_VIDEO) return { body: read(join(NASA, `player-${NASA_VIDEO}.json`)) };
        // Real responses recorded by the YouTube provider (prompt 06/07) for videos that are not live.
        return { body: read(join(import.meta.dirname, '../../../providers/youtube/test/fixtures', `player-${videoId}.json`)) };
      },
    },
    { url: /manifest\.googlevideo\.com\/api\/manifest\/hls_variant\//, response: { body: read(join(NASA, 'master.m3u8')) } },
    {
      url: /manifest\.googlevideo\.com\/api\/manifest\/hls_playlist\/.*\/itag\/91\//,
      response: () => ({ body: read(join(NASA, mediaCalls++ === 0 ? 'media-1.m3u8' : 'media-2.m3u8')) }),
    },
    {
      url: (u) => u.hostname.endsWith('.googlevideo.com') && /\/videoplayback\/.*\/sq\/\d+\//.test(u.pathname),
      response: (call) => {
        const sq = /\/sq\/(\d+)\//.exec(call.url)?.[1];
        const file = join(NASA, `seg-${sq}.mpegts`);
        if (!existsSync(file)) return { status: 404, body: '' };
        return { headers: { 'content-type': 'video/mp2t' }, body: bytes(file) };
      },
    },
  ];
}

/** The Apollo 11 live HLS states from test/fixtures/apollo-hls: each poll gets the next state, the last one carries ENDLIST. */
export function apolloRoutes(opts: { startState?: number } = {}): Route[] {
  let state = opts.startState ?? 1;
  return [
    {
      url: APOLLO_URL,
      response: () => {
        const body = read(join(APOLLO, `playlist-${state}.m3u8`));
        state = Math.min(state + 1, APOLLO_STATES);
        return { headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body };
      },
    },
    {
      url: /^http:\/\/localhost:8000\/apollo\/seg-\d+\.ts$/,
      response: (call) => {
        const name = call.url.split('/').pop()?.replace(/\.ts$/, '.mpegts') ?? '';
        return { headers: { 'content-type': 'video/mp2t' }, body: bytes(join(APOLLO, name)) };
      },
    },
  ];
}

export function sttRoute(responder: SttResponder): Route {
  return { method: 'POST', url: OVH_URL, response: responder };
}

/** Only the keyless OVH rung is enabled when no key is set, which is what these recordings use. */
export function sttRegistry(): Registry {
  return new Registry([stt], 'node');
}

export function liveContext(routes: Route[], signal?: AbortSignal): { ctx: Ctx; fetch: ReturnType<typeof replayFetch> } {
  const fetch = replayFetch(routes);
  return { ctx: testContext({ fetch, signal, env: { PATH: process.env.PATH } }), fetch };
}

export interface Scenario {
  name: string;
  input: string;
  routes: () => Route[];
  opts: WatchLiveOptions;
  /** Stop (abort) once this returns true for an event; omit to run until `done`. */
  stopWhen?: (e: LiveEvent, seen: LiveEvent[]) => boolean;
}

const rungs = (seen: LiveEvent[]) => seen.filter((e) => e.type === 'status' && e.code === 'rung').length;

export const SCENARIOS: Record<string, Scenario> = {
  nasaSequence: {
    name: 'nasa-sequence',
    input: NASA_URL,
    routes: nasaRoutes,
    opts: { fromSequence: 323509, chunkSec: 15, catchUpChunks: 1 },
    stopWhen: (_e, seen) => rungs(seen) >= 1,
  },
  nasaBackpressure: {
    name: 'nasa-backpressure',
    input: NASA_URL,
    routes: nasaRoutes,
    opts: { fromSequence: 323509, chunkSec: 5, maxLagSec: 6, catchUpChunks: 1 },
    stopWhen: (_e, seen) => rungs(seen) >= 2,
  },
  nasaResume: {
    name: 'nasa-resume',
    input: NASA_URL,
    routes: nasaRoutes,
    opts: { fromSequence: 323510, chunkSec: 10, catchUpChunks: 1 },
    stopWhen: (_e, seen) => rungs(seen) >= 1,
  },
  apolloOverlap: {
    name: 'apollo-overlap',
    input: APOLLO_URL,
    routes: () => apolloRoutes(),
    opts: { chunkSec: 10, overlapSec: 2, catchUpChunks: 1 },
  },
  apolloWhole: {
    name: 'apollo-whole',
    input: APOLLO_URL,
    routes: () => apolloRoutes(),
    opts: {},
  },
};

/**
 * Playlist polls wait at most 5 ms in tests instead of the target duration. A
 * real (short) timer, so the event loop still runs ffmpeg's I/O in between.
 */
export const fastSleep = (ms: number, signal?: AbortSignal) => abortableSleep(Math.min(ms, 5), signal);

/** Run a scenario to completion and return every event plus the replay fetch (for request assertions). */
export async function runScenario(
  s: Scenario,
  responder: SttResponder,
): Promise<{ events: LiveEvent[]; fetch: ReturnType<typeof replayFetch> }> {
  const stop = new AbortController();
  const { ctx, fetch } = liveContext([...s.routes(), sttRoute(responder)]);
  const events: LiveEvent[] = [];
  const watcher = watchLive(
    s.input,
    { ...s.opts, signal: stop.signal },
    { registry: sttRegistry(), ctx, extractAudio: createFfmpegExtractor({ env: ctx.env }), sleep: fastSleep },
  );
  for await (const e of watcher) {
    events.push(e);
    if (s.stopWhen?.(e, events)) stop.abort();
  }
  return { events, fetch };
}
