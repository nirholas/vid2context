/**
 * Test harness: a real SDK Client connected to a real McpServer over
 * InMemoryTransport, with the client's sampling handler backed by the real
 * vid2context LLM chain (`chat()` from core). Unit tests feed the chain
 * recorded keyless responses through replayFetch; the live test and the
 * recorder give it the real fetch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type ClientCapabilities,
  type CreateMessageRequest,
  CreateMessageRequestSchema,
  type CreateMessageResult,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { type Ctx, chat, MemoryStorage, Registry, type Storage, Vid2ContextError, type VideoContext } from '@vid2context/core';
import type { RecordedCall, Route } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import youtube from '@vid2context/provider-youtube';
import { registerAgenticFeatures } from '../src/index.ts';

export const FIXTURES = join(import.meta.dirname, 'fixtures');
const SHARED_CONTEXTS = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'contexts');
const YOUTUBE_FIXTURES = join(import.meta.dirname, '..', '..', '..', 'providers', 'youtube', 'test', 'fixtures');

export const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
export const GWAGON = 'https://www.youtube.com/watch?v=cCPsdFdlshc';
/** The question used for the recorded digest. */
export const QUESTION = 'Which G-Wagon years are the best and the worst to buy, and why?';
/** The chunk budget used for the recorded digest, small enough to split the 18-minute video. */
export const RECORDED_MAX_TOKENS = 2000;
export const SAMPLING_FIXTURE = 'sampling-digest-keyless.json';

/** A real VideoContext from tests/fixtures/contexts. */
export function sharedContext(id: string): VideoContext {
  return JSON.parse(readFileSync(join(SHARED_CONTEXTS, `youtube-${id}.json`), 'utf8')) as VideoContext;
}

export async function filledStorage(): Promise<MemoryStorage> {
  const s = new MemoryStorage();
  await s.putContext(sharedContext('jNQXAC9IVRw'));
  await s.putContext(sharedContext('cCPsdFdlshc'));
  return s;
}

/** YouTube source and captions plus the OpenAI-compatible LLM lanes: exactly what these tests exercise. */
export function testRegistry(): Registry {
  return new Registry([...youtube, llm], 'node');
}

// ---------------------------------------------------------------- sampling through the real chain

type SamplingMessage = CreateMessageRequest['params']['messages'][number];

function messageText(m: SamplingMessage): string {
  const blocks = Array.isArray(m.content) ? m.content : [m.content];
  return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/** The chat messages the chain sends for a sampling request: the system prompt first, then the messages. */
export function chatMessages(
  params: CreateMessageRequest['params'],
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  return [
    ...(params.systemPrompt ? [{ role: 'system' as const, content: params.systemPrompt }] : []),
    ...params.messages.map((m) => ({ role: m.role, content: messageText(m) })),
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A client sampling handler that answers with the vid2context LLM chain. With
 * `retries`, a chain that fails because every keyless lane is rate-limited
 * waits for the quota window and tries again (only live runs need this).
 */
export function chainSampler(
  registry: Registry,
  ctx: Ctx,
  opts: { retries?: number; waitMs?: number; calls?: CreateMessageRequest['params'][] } = {},
) {
  return async (req: CreateMessageRequest): Promise<CreateMessageResult> => {
    opts.calls?.push(req.params);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await chat(
          registry,
          { messages: chatMessages(req.params), maxTokens: req.params.maxTokens, temperature: req.params.temperature },
          {},
          ctx,
        );
        return { role: 'assistant', content: { type: 'text', text: res.text }, model: res.model, stopReason: 'endTurn' };
      } catch (err) {
        const retryable = err instanceof Vid2ContextError && err.code === 'all-rungs-failed';
        if (!retryable || attempt >= (opts.retries ?? 0)) throw err;
        console.error(`[sampler] every rung failed, waiting ${(opts.waitMs ?? 65_000) / 1000} s (attempt ${attempt + 1})`);
        await sleep(opts.waitMs ?? 65_000);
      }
    }
  };
}

export interface RecordedExchange {
  url: string;
  model: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  status: number;
  body: string;
}

export interface SamplingFixture {
  recordedAt: string;
  note: string;
  exchanges: RecordedExchange[];
}

export function samplingFixture(name = SAMPLING_FIXTURE): SamplingFixture {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as SamplingFixture;
}

/** The answer text of a recorded chat completion body. */
export function recordedAnswer(e: RecordedExchange): string {
  const json = JSON.parse(e.body) as { choices?: { message?: { content?: string | null } }[] };
  return (json.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Replays recorded chat completions keyed by the exact messages sent, so the
 * order in which concurrent map calls arrive does not matter. A request whose
 * messages were never recorded throws: the test then fails instead of
 * reaching the network.
 */
export function samplingRoutes(fixture: SamplingFixture): Route[] {
  return [
    {
      method: 'POST',
      url: (u) => u.pathname.endsWith('/chat/completions') || u.hostname === 'text.pollinations.ai',
      response: (call: RecordedCall) => {
        const sent = JSON.stringify((JSON.parse(String(call.body)) as { messages: unknown }).messages);
        const hit = fixture.exchanges.find((e) => JSON.stringify(e.messages) === sent);
        if (!hit) throw new Error(`no recorded chat completion for these messages: ${sent.slice(0, 300)}`);
        return { status: hit.status, body: hit.body, headers: { 'content-type': 'application/json' } };
      },
    },
  ];
}

// ---------------------------------------------------------------- YouTube replay (the youtube provider's own recordings)

/** Routes serving the YouTube provider's real recordings (providers/youtube/test/fixtures, read in place). */
export function youtubeRoutes(): Route[] {
  const fixture = (name: string) => readFileSync(join(YOUTUBE_FIXTURES, name), 'utf8');
  return [
    {
      method: 'POST',
      url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      response: (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        const name = ['jNQXAC9IVRw', 'cCPsdFdlshc'].includes(videoId) ? videoId : 'unavailable';
        return { body: fixture(`player-${name}.json`), headers: { 'content-type': 'application/json' } };
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en.*fmt=srv3/, response: { body: fixture('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=de.*fmt=srv3/, response: { body: fixture('timedtext-jNQXAC9IVRw-de.srv3.xml') } },
    { url: /timedtext\?v=cCPsdFdlshc.*lang=en.*fmt=srv3/, response: { body: fixture('timedtext-cCPsdFdlshc-en-asr.srv3.xml') } },
  ];
}

// ---------------------------------------------------------------- a connected client and server

export interface Harness {
  server: McpServer;
  client: Client;
  close(): Promise<void>;
}

export async function connect(opts: {
  registry: Registry;
  ctx: Ctx;
  storage: Storage | null;
  capabilities?: ClientCapabilities;
  sampling?: (req: CreateMessageRequest) => Promise<CreateMessageResult>;
  elicit?: (req: ElicitRequest) => Promise<ElicitResult>;
}): Promise<Harness> {
  const server = new McpServer({ name: 'vid2context-test', version: '0.0.0' });
  registerAgenticFeatures(server, { registry: opts.registry, ctx: opts.ctx, storage: async () => opts.storage });
  const client = new Client({ name: 'vid2context-test-client', version: '0.0.0' }, { capabilities: opts.capabilities ?? {} });
  if (opts.sampling) client.setRequestHandler(CreateMessageRequestSchema, opts.sampling);
  if (opts.elicit) client.setRequestHandler(ElicitRequestSchema, opts.elicit);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    server,
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** The text of a tool result. */
export function resultText(res: unknown): string {
  const content = (res as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}
