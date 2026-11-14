/**
 * Shared test plumbing: a registry built from the real providers, and replay
 * routes that serve the recorded YouTube and LLM responses. Every response
 * here is a real recording; see test/fixtures/README.md for where each came from.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Registry } from '@vid2context/core';
import type { Route } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import mediaFile from '@vid2context/provider-media-file';
import youtube from '@vid2context/provider-youtube';

export const ROOT = join(import.meta.dirname, '../../..');
export const FIXTURES = join(import.meta.dirname, 'fixtures');

export const readRepo = (p: string) => readFileSync(join(ROOT, p), 'utf8');
export const readFixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(readFixture(name)) as T;

/** The video every route test summarizes: "Best & Worst G-Wagon Years", 18 minutes, auto-captions. */
export const VIDEO_ID = 'cCPsdFdlshc';
export const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
export const LLM_FIXTURE = `llm-summary-${VIDEO_ID}.json`;

/**
 * Explicit providers instead of the generated registry, so providers other
 * work adds later cannot change which rungs these tests reach.
 */
export function testRegistry(): Registry {
  return new Registry([...youtube, mediaFile, llm], 'node');
}

/** The recorded YouTube player and timedtext responses (shared with providers/youtube). */
export function youtubeRoutes(): Route[] {
  const yt = (name: string) => readRepo(`providers/youtube/test/fixtures/${name}`);
  return [
    {
      method: 'POST',
      url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      response: (call) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        const name = ['jNQXAC9IVRw', 'cCPsdFdlshc'].includes(videoId) ? videoId : 'unavailable';
        return { body: yt(`player-${name}.json`), headers: { 'content-type': 'application/json' } };
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en.*fmt=srv3/, response: { body: yt('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    { url: /timedtext\?v=cCPsdFdlshc.*lang=en.*fmt=srv3/, response: { body: yt('timedtext-cCPsdFdlshc-en-asr.srv3.xml') } },
  ];
}

export interface LlmRecording {
  recordedAt: string;
  rung: string;
  url: string;
  request: { model: string; messages: { role: string; content: string }[] };
  status: number;
  response: unknown;
}

/**
 * Serves the recorded summary completion, but only for the exact request it was
 * recorded with: a changed prompt fails loudly instead of replaying a stale answer.
 */
export function llmRoute(): Route {
  const rec = fixtureJson<LlmRecording>(LLM_FIXTURE);
  return {
    method: 'POST',
    url: rec.url,
    response: (call) => {
      const body = JSON.parse(String(call.body)) as LlmRecording['request'];
      if (body.model !== rec.request.model) return { status: 503, body: '{"error":"not recorded for this model"}' };
      if (JSON.stringify(body.messages) !== JSON.stringify(rec.request.messages)) {
        throw new Error(`The summary prompt changed since ${LLM_FIXTURE} was recorded. Re-record: LIVE=1 npm run -w packages/bots record`);
      }
      return { status: rec.status, body: JSON.stringify(rec.response), headers: { 'content-type': 'application/json' } };
    },
  };
}
