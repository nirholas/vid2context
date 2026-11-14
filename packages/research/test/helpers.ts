/**
 * Shared test setup. Every payload here is real: VideoContext JSON from
 * tests/fixtures/contexts, innertube player responses from
 * providers/youtube/test/fixtures (read-only), and LLM answers recorded into
 * this package's test/fixtures (see its README).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ctx, type Env, MemoryStorage, type Provider, Registry, type VideoContext } from '@vid2context/core';
import { type RecordedCall, type Route, replayFetch, testContext } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import mediaFile from '@vid2context/provider-media-file';
import youtube from '@vid2context/provider-youtube';

export const ROOT = join(import.meta.dirname, '../../..');
export const GWAGON = 'https://www.youtube.com/watch?v=cCPsdFdlshc';
export const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
export const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

export const loadContext = (id: string): VideoContext =>
  JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/contexts', `youtube-${id}.json`), 'utf8')) as VideoContext;

const youtubeFixture = (name: string) => readFileSync(join(ROOT, 'providers/youtube/test/fixtures', name), 'utf8');

export interface RecordedLlmCall {
  url: string;
  model: string;
  status: number;
  request: { model: string; messages: { role: string; content: string }[] };
  response: string;
}

export interface LlmFixture {
  recordedAt: string;
  options: { count: number; chunkTokens?: number };
  rung: string;
  calls: RecordedLlmCall[];
}

export const loadLlmFixture = (name: string): LlmFixture =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as LlmFixture;

/** Answers innertube player requests from the real recorded responses. */
export const playerRoute: Route = {
  method: 'POST',
  url: PLAYER_URL,
  response: (call: RecordedCall) => {
    const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
    const name = ['jNQXAC9IVRw', 'cCPsdFdlshc'].includes(videoId) ? videoId : 'unavailable';
    return { body: youtubeFixture(`player-${name}.json`), headers: { 'content-type': 'application/json' } };
  },
};

/** Answers LLM calls with the recorded response for the same endpoint, model and messages; anything else fails like a dead host. */
export function llmRoute(fixture: LlmFixture): Route {
  return {
    method: 'POST',
    url: (u) => fixture.calls.some((c) => c.url === u.href),
    response: (call: RecordedCall) => {
      const body = JSON.parse(String(call.body)) as RecordedLlmCall['request'];
      const hit = fixture.calls.find(
        (c) => c.url === call.url && c.model === body.model && JSON.stringify(c.request.messages) === JSON.stringify(body.messages),
      );
      if (!hit) throw new Error(`no recorded LLM response for ${body.model} with these messages`);
      return { status: hit.status, body: hit.response, headers: { 'content-type': 'application/json' } };
    },
  };
}

const flat = (...p: (Provider | Provider[])[]): Provider[] => p.flat();

export function makeRegistry(): Registry {
  return new Registry(flat(youtube, llm, mediaFile), 'node');
}

export async function filledStorage(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  await storage.putContext(loadContext('cCPsdFdlshc'));
  await storage.putContext(loadContext('jNQXAC9IVRw'));
  return storage;
}

export function ctxWith(routes: Route[], env: Env = {}): Ctx & { fetch: ReturnType<typeof replayFetch> } {
  const fetch = replayFetch(routes);
  return testContext({ fetch, env }) as Ctx & { fetch: typeof fetch };
}
