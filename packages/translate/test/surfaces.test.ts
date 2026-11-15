import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  attemptsOf,
  clearCooldowns,
  formatters,
  MemoryStorage,
  Registry,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { type RecordedCall, type Route, replayFetch, testContext } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import { resetBreaker, youtubeCaptions, youtubeSource } from '@vid2context/provider-youtube';
import { type RecordedExchange, readRecorded } from '@vid2context/testkit/recorder';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { translateRoutes } from '../src/http.ts';
import { registerTranslateTools } from '../src/mcp.ts';

// Real data only: shared VideoContext fixtures, YouTube responses recorded by
// the youtube provider, and the OVH answer recorded by scripts/record.ts (the
// first 30 segments of the G-Wagon video, translated to German).
const root = join(import.meta.dirname, '..', '..', '..');
const loadContext = (id: string): VideoContext =>
  JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'contexts', `youtube-${id}.json`), 'utf8')) as VideoContext;
const yt = (name: string) => readFileSync(join(root, 'providers', 'youtube', 'test', 'fixtures', name), 'utf8');

const full = loadContext('cCPsdFdlshc');
const gwagon30: VideoContext = { ...full, transcript: { ...full.transcript, segments: full.transcript.segments.slice(0, 30) } };
const zoo = loadContext('jNQXAC9IVRw');
const GWAGON = 'https://www.youtube.com/watch?v=cCPsdFdlshc';
const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const OVH = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
const [whole] = readRecorded(join(import.meta.dirname, 'fixtures'), { name: 'llm-de-whole' }).map((r) => r.exchange);

/** Serve recorded OVH answers in this order; any extra call fails like a dead host. */
function ovhQueue(answers: (RecordedExchange | undefined)[]): Route {
  let i = 0;
  return {
    method: 'POST',
    url: OVH,
    response: () => {
      const ex = answers[i++];
      if (!ex) throw new Error('unexpected extra LLM call');
      return { status: ex.response.status, headers: { 'content-type': 'application/json' }, body: ex.response.body };
    },
  };
}

const youtubeRoutes: Route[] = [
  {
    method: 'POST',
    url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    response: (call: RecordedCall) => {
      const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
      const name = ['jNQXAC9IVRw', 'cCPsdFdlshc'].includes(videoId) ? videoId : 'unavailable';
      return { body: yt(`player-${name}.json`), headers: { 'content-type': 'application/json' } };
    },
  },
  { url: /timedtext\?v=jNQXAC9IVRw.*lang=de.*fmt=srv3/, response: { body: yt('timedtext-jNQXAC9IVRw-de.srv3.xml') } },
  { url: /timedtext\?v=cCPsdFdlshc.*tlang=de/, response: { status: 429, body: yt('timedtext-429-blocked.html') } },
];

const registry = new Registry([youtubeSource, youtubeCaptions, llm], 'node');

/** The source contexts are saved, as the library would hold them after a first read. */
async function library(): Promise<MemoryStorage> {
  const s = new MemoryStorage();
  await s.putContext(gwagon30);
  await s.putContext(zoo);
  return s;
}

function setup(answers: (RecordedExchange | undefined)[] = []) {
  const fetch = replayFetch([...youtubeRoutes, ovhQueue(answers)]);
  return { fetch, ctx: testContext({ fetch }), llmCalls: () => fetch.calls.filter((c) => c.url === OVH) };
}

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

async function mcp(answers: (RecordedExchange | undefined)[] = [], storage?: MemoryStorage) {
  const s = setup(answers);
  const store = storage ?? (await library());
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTranslateTools(server, { registry, ctx: s.ctx, storage: store });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args: Record<string, unknown>) =>
    (await client.callTool({ name: 'translate_transcript', arguments: args })) as TextResult;
  return { ...s, client, call, store };
}

/** Mounted the way the server mounts sub-apps; the parent's onError writes the standard error body. */
async function http(answers: (RecordedExchange | undefined)[] = []) {
  const s = setup(answers);
  const store = await library();
  const parent = new Hono();
  parent.onError((err, c) => {
    const e = err instanceof Vid2ContextError ? err : undefined;
    return c.json(
      {
        error: { code: e?.code ?? 'internal', message: err.message, ...(e?.hint ? { hint: e.hint } : {}) },
        attempts: attemptsOf(err),
      },
      e?.code === 'bad-request' ? 400 : e?.code === 'no-transcript' ? 422 : e?.code === 'not-found' ? 404 : 500,
    );
  });
  parent.route('/api/v1', translateRoutes({ registry, makeCtx: () => s.ctx, storage: async () => store }));
  return { ...s, store, get: (q: string) => parent.request(`/api/v1/translate?${q}`) };
}

const textOf = (r: TextResult, i = 0) => r.content[i]?.text ?? '';

beforeEach(() => {
  clearCooldowns();
  // A recorded HTTP 429 pauses YouTube caption downloads process-wide; each test starts unblocked.
  resetBreaker();
});

describe('MCP translate_transcript', () => {
  it('is listed as read-only with every core format', async () => {
    const { client } = await mcp();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['translate_transcript']);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    const props = (tools[0]?.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
    expect(props.format?.enum).toEqual(Object.keys(formatters));
  });

  it('uses YouTube\'s own de track for "Me at the zoo", with a header and no LLM call', async () => {
    const { call, llmCalls, store } = await mcp();
    const res = await call({ url: ZOO, language: 'de', timestamps: true });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain('Title: Me at the zoo');
    expect(text).toContain(
      "Translation: en to de (German) via the platform's own track or machine translation (youtube-captions)",
    );
    expect(text).toContain('The en source transcript is kept unchanged.');
    expect(text).toMatch(/\n\[0:0\d\] /);
    expect(llmCalls()).toHaveLength(0);
    expect((await store.getContext(zoo.metadata.ref.id))?.transcript.language).toBe('en');
  });

  it('falls back to the LLM when YouTube blocks tlang, reporting the path and the attempts in JSON', async () => {
    const { call, llmCalls, store } = await mcp([whole]);
    const res = await call({ url: GWAGON, language: 'de', format: 'json' });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(textOf(res));
    expect(llmCalls()).toHaveLength(1);
    expect(body).toMatchObject({
      videoId: 'youtube:cCPsdFdlshc',
      language: 'de',
      via: 'llm',
      model: 'gpt-oss-120b',
      report: { chunks: 1, retried: [], failed: [], untranslatedSegments: 0 },
      source: { language: 'en', origin: 'auto-captions', segments: 30 },
    });
    expect(body.attempts.some((a: { stage: string; outcome: string }) => a.stage === 'captions' && a.outcome === 'error')).toBe(
      true,
    );
    expect(body.context.transcript).toMatchObject({ language: 'de', translated: true });
    expect(body.context.transcript.segments[13].text).toBe('ist der G-Wagon-Spezialist und hilft mir');
    expect(body.sourceTranscript).toEqual(gwagon30.transcript);
    expect(await store.getContext(gwagon30.metadata.ref.id)).toEqual(gwagon30);
  });

  it('returns srt plus a separate report block', async () => {
    const { call } = await mcp([whole]);
    const res = await call({ url: GWAGON, language: 'de', format: 'srt' });
    expect(res.content).toHaveLength(2);
    expect(textOf(res)).toMatch(/^1\n00:00:0\d,\d{3} --> /);
    expect(textOf(res)).toContain('ist der G-Wagon-Spezialist und hilft mir');
    expect(JSON.parse(textOf(res, 1))).toMatchObject({ via: 'llm', language: 'de' });
  });

  it('returns errors as tool results with code, hint and attempts', async () => {
    const { call } = await mcp();
    const badLang = await call({ url: ZOO, language: 'German please' });
    expect(badLang.isError).toBe(true);
    expect(JSON.parse(textOf(badLang))).toMatchObject({ error: 'bad-request', hint: expect.stringContaining('BCP-47') });
    const noTrack = await call({ url: GWAGON, language: 'de', llm: false });
    expect(noTrack.isError).toBe(true);
    const body = JSON.parse(textOf(noTrack));
    expect(body).toMatchObject({ error: 'no-transcript', hint: expect.any(String) });
    expect(body.attempts.some((a: { stage: string }) => a.stage === 'captions')).toBe(true);
    const gone = await call({ url: 'https://youtu.be/xxxxxxxxxxx', language: 'de' });
    expect(JSON.parse(textOf(gone)).error).toBe('not-found');
  });
});

describe('HTTP GET /translate', () => {
  it('returns text with the formatter content type and the path in headers', async () => {
    const { get, llmCalls } = await http();
    const res = await get(`url=${encodeURIComponent(ZOO)}&lang=de`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(formatters.text?.mimeType);
    expect(res.headers.get('x-translated-via')).toBe('platform');
    expect(res.headers.get('x-translation-producer')).toBe('youtube-captions');
    expect(res.headers.get('x-source-language')).toBe('en');
    expect((await res.text()).length).toBeGreaterThan(0);
    expect(llmCalls()).toHaveLength(0);
  });

  it('accepts input= and returns vtt, or the full result as JSON', async () => {
    const vtt = await (await http([whole])).get(`input=${encodeURIComponent(GWAGON)}&lang=de&format=vtt`);
    expect(vtt.status).toBe(200);
    expect(vtt.headers.get('content-type')).toBe(formatters.vtt?.mimeType);
    expect(vtt.headers.get('x-translated-via')).toBe('llm');
    expect(await vtt.text()).toMatch(/^WEBVTT/);
    const json = await (await http([whole])).get(`url=${encodeURIComponent(GWAGON)}&lang=de&format=json`);
    expect(json.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await json.json();
    expect(body).toMatchObject({ via: 'llm', language: 'de', source: { language: 'en' } });
    expect(body.sourceTranscript.language).toBe('en');
  });

  it('rejects bad requests with 400 and a hint', async () => {
    const { get } = await http();
    for (const q of [
      'lang=de',
      `url=${encodeURIComponent(ZOO)}`,
      `url=${encodeURIComponent(ZOO)}&lang=de&format=docx`,
      `url=${encodeURIComponent(ZOO)}&lang=de&mode=fast`,
      `url=${encodeURIComponent(ZOO)}&lang=de&timestamps=maybe`,
      `url=${encodeURIComponent(ZOO)}&lang=not a language`,
    ]) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('bad-request');
      expect(body.error.hint).toBeTruthy();
    }
    const noTrack = await get(`url=${encodeURIComponent(GWAGON)}&lang=de&llm=0`);
    expect(noTrack.status).toBe(422);
    expect((await noTrack.json()).error.code).toBe('no-transcript');
  });
});
