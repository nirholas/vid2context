/**
 * Test setup: the real app on a registry with the real YouTube and
 * OpenAI-compatible speech-to-text providers, and a replayFetch that answers
 * only from responses recorded from the real services (YouTube and OVH
 * fixtures in providers/, SponsorBlock fixtures in packages/skips/, shared
 * VideoContext fixtures in tests/fixtures/). Nothing here reaches the network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Env, MemoryStorage, Registry, type Storage, type VideoContext } from '@vid2context/core';
import { type RecordedCall, type ReplayFetch, type Route, replayFetch, testContext } from '@vid2context/core/testing';
import stt from '@vid2context/provider-stt-openai-compatible';
import youtube, { resetBreaker } from '@vid2context/provider-youtube';
import { type AccessLogEntry, type AppOptions, createApp, type ServerApp } from '../src/app.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

export const yt = (name: string): string => read('providers', 'youtube', 'test', 'fixtures', name);
export const ovh = (name: string): string => read('providers', 'stt-openai-compatible', 'test', 'fixtures', name);
export const sponsorblock = (name: string): string => read('packages', 'skips', 'test', 'fixtures', name);
export const sharedContext = (name: string): VideoContext =>
  JSON.parse(read('tests', 'fixtures', 'contexts', name)) as VideoContext;
export const skipsContext = (): VideoContext => JSON.parse(sponsorblock('context-youtube-CrO0Timw2z4.json')) as VideoContext;
export const APOLLO_MP3 = join(root, 'tests', 'fixtures', 'media', 'apollo11-small-step.mp3');

export const OVH_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions';
const JSON_HEADERS = { 'content-type': 'application/json' };
const COMMENTS_VIDEO = 'Pqdv2ql971M';

/** Every call the tests make, each answered with a real recording. */
export function recordedRoutes(): Route[] {
  let continuations = 0;
  return [
    {
      method: 'POST',
      url: /youtubei\/v1\/player/,
      response: (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        const file =
          videoId === 'jNQXAC9IVRw' || videoId === 'cCPsdFdlshc' ? `player-${videoId}.json` : 'player-unavailable.json';
        return { body: yt(file), headers: JSON_HEADERS };
      },
    },
    {
      method: 'POST',
      url: /youtubei\/v1\/next/,
      response: (call: RecordedCall) => {
        const body = JSON.parse(String(call.body)) as { videoId?: string; continuation?: string };
        if (body.videoId === COMMENTS_VIDEO) return { body: yt(`next-${COMMENTS_VIDEO}.json`), headers: JSON_HEADERS };
        // The first continuation is the comments section token from the next response; one page covers the limits used here.
        if (body.continuation && continuations++ === 0)
          return { body: yt(`comments-${COMMENTS_VIDEO}-top-1.json`), headers: JSON_HEADERS };
        throw new Error(`no recorded next response for ${String(call.body).slice(0, 160)}`);
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en/, response: { body: yt('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=de/, response: { body: yt('timedtext-jNQXAC9IVRw-de.srv3.xml') } },
    { url: /timedtext\?v=cCPsdFdlshc/, response: { body: yt('timedtext-cCPsdFdlshc-en-asr.srv3.xml') } },
    { method: 'POST', url: OVH_URL, response: { body: ovh('ovh-whisper-large-v3-turbo.verbose.json'), headers: JSON_HEADERS } },
    {
      url: /sponsor\.ajay\.app\/api\/skipSegments\/9007/,
      response: { body: sponsorblock('skipSegments-9007.json'), headers: JSON_HEADERS },
    },
  ];
}

export function testRegistry(): Registry {
  return new Registry([youtube, stt].flat(), 'node');
}

export interface TestApp {
  app: ServerApp;
  fetch: ReplayFetch;
  logs: AccessLogEntry[];
  env: Env;
}

/**
 * The real app with recorded responses. Each call gets a fresh env object and
 * a reset YouTube breaker, so apps never share state (the provider caches per env object).
 */
export function makeApp(opts: { env?: Env; storage?: Storage; routes?: Route[]; app?: Partial<AppOptions> } = {}): TestApp {
  resetBreaker();
  const fetch = replayFetch(opts.routes ?? recordedRoutes());
  const env: Env = { VID2CONTEXT_RATE_LIMIT: '0', ...opts.env };
  const logs: AccessLogEntry[] = [];
  const storage = opts.storage;
  const app = createApp({
    registry: testRegistry(),
    makeCtx: (req) => testContext({ fetch, env, signal: req.signal }),
    onAccessLog: (e) => logs.push(e),
    ...(storage ? { storage: async () => storage } : {}),
    ...opts.app,
  });
  return { app, fetch, logs, env };
}

/** A MemoryStorage holding the real VideoContext fixtures, plus a collection of the two shared ones. */
export async function seededStorage(): Promise<{ storage: MemoryStorage; collectionId: string }> {
  const storage = new MemoryStorage();
  const zoo = sharedContext('youtube-jNQXAC9IVRw.json');
  const wagon = sharedContext('youtube-cCPsdFdlshc.json');
  await storage.putContext(zoo);
  await storage.putContext(wagon);
  await storage.putContext(skipsContext());
  const collection = await storage.createCollection({ name: 'Fixtures' });
  await storage.addToCollection(collection.id, [zoo.metadata.ref.id, wagon.metadata.ref.id]);
  return { storage, collectionId: collection.id };
}

export const calls = (fetch: ReplayFetch, pattern: RegExp): number => fetch.calls.filter((c) => pattern.test(c.url)).length;
