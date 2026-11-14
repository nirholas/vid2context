/**
 * Shared test plumbing: a registry built from the real providers, and replay
 * routes that serve the recorded YouTube and LLM responses. Every response
 * here is a real recording; see test/fixtures/README.md for where each came from.
 */
import { createContext, type Env, type Logger, Registry } from '@vid2context/core';
import { type Route, replayFetch } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import mediaFile from '@vid2context/provider-media-file';
import youtube from '@vid2context/provider-youtube';
import { botsRoutes } from '../src/http.ts';
import { fixtureJson, readRepo } from './util.ts';

export * from './util.ts';

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
 * recorded with. A changed prompt (or a transcript that parses differently)
 * is recorded in `state.mismatch`, so tests fail with a clear message instead
 * of replaying a stale answer.
 */
export function llmRoute(): { route: Route; state: { mismatch?: string; calls: number } } {
  const rec = fixtureJson<LlmRecording>(LLM_FIXTURE);
  const state: { mismatch?: string; calls: number } = { calls: 0 };
  const route: Route = {
    method: 'POST',
    url: rec.url,
    response: (call) => {
      state.calls++;
      const body = JSON.parse(String(call.body)) as LlmRecording['request'];
      if (body.model !== rec.request.model)
        throw new Error(`${LLM_FIXTURE} was recorded for ${rec.request.model}, not ${body.model}`);
      if (JSON.stringify(body.messages) !== JSON.stringify(rec.request.messages)) {
        state.mismatch = `The summary request changed since ${LLM_FIXTURE} was recorded. Re-record: LIVE=1 npm run -w packages/bots record`;
        throw new Error(state.mismatch);
      }
      return { status: rec.status, body: JSON.stringify(rec.response), headers: { 'content-type': 'application/json' } };
    },
  };
  return { route, state };
}

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * The bots routes wired to the replayed pipeline: YouTube and LLM fixtures plus
 * the platform responses a test adds. Background work is collected through
 * `waitUntil`, so `settle()` waits for the replies to be sent.
 */
export function harness(env: Env, routes: Route[] = [], opts: { now?: () => number } = {}) {
  const llm = llmRoute();
  const fetch = replayFetch([...youtubeRoutes(), llm.route, ...routes]);
  const logs: LogLine[] = [];
  const log: Logger = {
    debug: (msg, data) => logs.push({ level: 'debug', msg, data }),
    info: (msg, data) => logs.push({ level: 'info', msg, data }),
    warn: (msg, data) => logs.push({ level: 'warn', msg, data }),
    error: (msg, data) => logs.push({ level: 'error', msg, data }),
  };
  const tasks: Promise<unknown>[] = [];
  const app = botsRoutes({
    registry: testRegistry(),
    makeCtx: (req) => createContext({ runtime: 'node', env, fetch, log, signal: req.signal }),
    waitUntil: (p) => {
      tasks.push(p);
    },
    now: opts.now,
  });
  return {
    app,
    fetch,
    logs,
    llm: llm.state,
    settle: async () => {
      await Promise.all(tasks);
    },
    /** Calls made to URLs matching `re`, in order. */
    calls: (re: RegExp) => fetch.calls.filter((c) => re.test(c.url)),
  };
}
