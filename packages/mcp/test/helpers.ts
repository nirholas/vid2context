/**
 * Test harness: a real MCP Client connected to createServer over the SDK's
 * in-memory linked transport pair, against a Registry of the YouTube and
 * OpenAI-compatible LLM providers whose network calls replay real recordings
 * from providers/youtube/test/fixtures (see its README for when and how each
 * was recorded).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type Env, MemoryStorage, type Provider, Registry } from '@vid2context/core';
import { type RecordedCall, replayFetch, testContext } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import youtube from '@vid2context/provider-youtube';
import { createServer } from '../src/server.ts';

export const root = join(import.meta.dirname, '../../..');
const ytDir = join(root, 'providers/youtube/test/fixtures');
export const yt = (p: string) => readFileSync(join(ytDir, p), 'utf8');

export const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
export const GWAGON = 'https://www.youtube.com/watch?v=cCPsdFdlshc';
export const COMMENTS_VIDEO = 'https://www.youtube.com/watch?v=Pqdv2ql971M';
/** "G-Wagon" playlist recorded by the YouTube browse work (browse-gwagon.json). */
export const GWAGON_PLAYLIST = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';

const PLAYERS: Record<string, string> = {
  jNQXAC9IVRw: 'player-jNQXAC9IVRw.json',
  cCPsdFdlshc: 'player-cCPsdFdlshc.json',
};

interface BrowseRecord {
  endpoint: string;
  body: Record<string, string>;
  file: string;
  status: number;
}

const browseRecords = JSON.parse(readFileSync(join(ytDir, 'browse/requests.json'), 'utf8')) as BrowseRecord[];
const browseKey = (endpoint: string, b: Record<string, unknown>) =>
  JSON.stringify([endpoint, b.browseId ?? null, b.params ?? null, b.continuation ?? null, b.url ?? null, b.query ?? null]);

const json = (body: string, status = 200) => ({ body, status, headers: { 'content-type': 'application/json' } });

export function youtubeReplay() {
  return replayFetch([
    {
      method: 'POST',
      url: /youtubei\/v1\/player/,
      response: (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        return json(yt(PLAYERS[videoId] ?? 'player-unavailable.json'));
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en/, response: { body: yt('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    { url: /timedtext\?v=cCPsdFdlshc.*lang=en/, response: { body: yt('timedtext-cCPsdFdlshc-en-asr.srv3.xml') } },
    {
      // Comments: the recorded `next` response for the video, then its first Top page for the continuation.
      method: 'POST',
      url: /youtubei\/v1\/next/,
      response: (call: RecordedCall) => {
        const body = JSON.parse(String(call.body)) as { videoId?: string; continuation?: string };
        if (body.videoId === 'Pqdv2ql971M') return json(yt('next-Pqdv2ql971M.json'));
        if (body.continuation) return json(yt('comments-Pqdv2ql971M-top-1.json'));
        return json(yt('next-xxxxxxxxxxx.json'));
      },
    },
    {
      method: 'POST',
      url: /youtubei\/v1\/(browse|navigation\/resolve_url|search)/,
      response: (call: RecordedCall) => {
        const endpoint = /youtubei\/v1\/([a-z_/]+)/.exec(call.url)?.[1] ?? '';
        const key = browseKey(endpoint, JSON.parse(String(call.body)) as Record<string, unknown>);
        const rec = browseRecords.find((r) => browseKey(r.endpoint, r.body) === key);
        if (!rec) throw new Error(`no recorded ${endpoint} response for ${String(call.body).slice(0, 200)}`);
        return json(yt(`browse/${rec.file}`), rec.status);
      },
    },
  ]);
}

export function testRegistry(): Registry {
  return new Registry([...[youtube].flat(), ...[llm].flat()] as Provider[], 'node');
}

export async function connect(opts: { env?: Env } = {}) {
  const fetch = youtubeReplay();
  const storage = new MemoryStorage();
  // Replies off: the comment tests replay one recorded page, so no reply requests are made.
  const ctx = testContext({ fetch, env: { YOUTUBE_COMMENT_REPLIES: '0', ...opts.env } });
  const server = createServer(testRegistry(), ctx, '0.0.0-test', { storage });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, storage, fetch };
}

export type TextResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<TextResult> {
  return (await client.callTool({ name, arguments: args })) as TextResult;
}

export const textOf = (r: TextResult) => r.content[0]?.text ?? '';
export const jsonOf = <T = Record<string, unknown>>(r: TextResult) => JSON.parse(textOf(r)) as T;
