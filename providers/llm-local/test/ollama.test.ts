import { type ChatStreamEvent, Vid2ContextError } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { ollamaChat, ollamaStream, parseShow, planContext, versionAtLeast } from '../src/ollama.ts';
import { normalizeOllamaBase } from '../src/servers.ts';
import { bodyWithStatus, collect, fixture, httpFixture, jsonBody } from './helpers.ts';
import { longTranscriptRequest } from './long-transcript.ts';

// Real responses from Ollama 0.40.16 on 2026-11-14 (see test/fixtures/README.md).
// Each test uses its own base URL because /api/show and /api/version are cached per base and model.
function ollama(
  base: string,
  chat: string | ((body: Record<string, unknown>) => string),
  show = 'ollama-show-qwen2.5-0.5b.json',
) {
  return replayFetch([
    { method: 'POST', url: `${base}/api/show`, response: { body: fixture(show) } },
    { method: 'GET', url: `${base}/api/version`, response: httpFixture('ollama-api-version.http') },
    {
      method: 'POST',
      url: `${base}/api/chat`,
      response: (call) => ({ body: typeof chat === 'string' ? fixture(chat) : chat(jsonBody(call)) }),
    },
  ]);
}

const question = {
  messages: [{ role: 'user' as const, content: 'Which year did Apollo 11 land on the moon? Answer in one short sentence.' }],
  maxTokens: 64,
  temperature: 0,
};

describe('base URL', () => {
  it('accepts the foundation value with /v1 and strips it for the native API', () => {
    expect(normalizeOllamaBase('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(normalizeOllamaBase('http://localhost:11434/v1/')).toBe('http://localhost:11434');
    expect(normalizeOllamaBase('http://gpu-box:11434/api')).toBe('http://gpu-box:11434');
    expect(normalizeOllamaBase('127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaBase(undefined)).toBe('http://localhost:11434');
    expect(normalizeOllamaBase('  ')).toBe('http://localhost:11434');
  });
});

describe('/api/show', () => {
  it('reads the context length and capabilities', () => {
    expect(parseShow(JSON.parse(fixture('ollama-show-qwen2.5-0.5b.json')))).toEqual({
      contextLength: 32768,
      capabilities: ['completion', 'tools'],
      parameterSize: '494.03M',
      quantization: 'Q4_K_M',
      family: 'qwen2',
    });
    const embed = parseShow(JSON.parse(fixture('ollama-show-nomic-embed-text.json')));
    expect(embed.contextLength).toBe(2048);
    expect(embed.capabilities).toEqual(['embedding']);
  });

  it('compares versions', () => {
    expect(versionAtLeast('0.40.16', '0.5.0')).toBe(true);
    expect(versionAtLeast('0.4.7', '0.5.0')).toBe(false);
    expect(versionAtLeast('0.5.0-rc1', '0.5.0')).toBe(true);
    expect(versionAtLeast(undefined, '0.5.0')).toBe(false);
  });
});

describe('context sizing', () => {
  it('sizes num_ctx for a real 18-minute transcript so nothing is truncated', async () => {
    const base = 'http://ollama-long:11434';
    const f = ollama(base, 'ollama-chat-long-transcript.response.json');
    const req = longTranscriptRequest();
    const res = await ollamaChat({ base, model: 'qwen2.5:0.5b' }, req, testContext({ fetch: f }));

    const sent = jsonBody(f.calls.find((c) => c.url.endsWith('/api/chat')) as { body: unknown });
    const options = sent.options as { num_ctx: number; num_predict: number };
    // Ollama counted 4,644 prompt tokens for this exact request; the default window keeps about 2,050.
    const evaluated = res.usage?.inputTokens as number;
    expect(evaluated).toBe(4644);
    expect(options.num_ctx).toBeGreaterThanOrEqual(evaluated + options.num_predict);
    expect(options.num_ctx).toBeLessThanOrEqual(32768);
    expect(options.num_ctx % 2048).toBe(0);
    expect(options.num_predict).toBe(120);
    // The recorded answer names the host from the first minute, which a truncated prompt loses.
    expect(res.text).toContain('Adam');
    // The body sent matches the recorded request byte for byte.
    expect(sent).toEqual(JSON.parse(fixture('ollama-chat-long-transcript.request.json')));
  });

  it('reads the model maximum once per model', async () => {
    const base = 'http://ollama-once:11434';
    const f = ollama(base, 'ollama-chat.json');
    const ctx = testContext({ fetch: f });
    await ollamaChat({ base, model: 'qwen2.5:0.5b' }, question, ctx);
    await ollamaChat({ base, model: 'qwen2.5:0.5b' }, question, ctx);
    expect(f.calls.filter((c) => c.url.endsWith('/api/show'))).toHaveLength(1);
    expect(f.calls.filter((c) => c.url.endsWith('/api/chat'))).toHaveLength(2);
  });

  it('throws too-large instead of truncating when the prompt exceeds the model maximum', async () => {
    const base = 'http://ollama-big:11434';
    const f = ollama(base, 'ollama-chat.json');
    const long = longTranscriptRequest();
    // Eight copies of the real transcript: about 37k tokens against qwen2.5:0.5b's 32,768.
    const huge = { ...long, messages: [{ role: 'user' as const, content: Array(8).fill(long.messages[1]?.content).join('\n') }] };
    const err = await ollamaChat({ base, model: 'qwen2.5:0.5b' }, huge, testContext({ fetch: f })).catch((e) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err.code).toBe('too-large');
    expect(err.message).toContain('32768');
    expect(err.hint).toContain('llama3.1:8b');
    expect(f.calls.some((c) => c.url.endsWith('/api/chat'))).toBe(false);
  });

  it('clamps num_predict so generation cannot overflow the window', () => {
    const long = longTranscriptRequest();
    const plan = planContext({ ...long, maxTokens: 8000 }, 8192, 'm');
    expect(plan.numCtx).toBe(8192);
    expect(plan.promptTokens + plan.numPredict).toBe(8192);
  });

  it('leaves num_ctx uncapped when the model maximum is unknown', () => {
    const plan = planContext(longTranscriptRequest(), undefined, 'm');
    expect(plan.numCtx % 2048).toBe(0);
    expect(plan.numCtx).toBeGreaterThan(plan.promptTokens);
  });
});

describe('chat', () => {
  it('answers through /api/chat with usage', async () => {
    const base = 'http://ollama-chat:11434';
    const f = ollama(base, 'ollama-chat.json');
    const res = await ollamaChat({ base, model: 'qwen2.5:0.5b', keepAlive: '30m' }, question, testContext({ fetch: f }));
    expect(res).toEqual({
      text: 'Apollo 11 landed on the moon in 1969.',
      model: 'qwen2.5:0.5b',
      usage: { inputTokens: 47, outputTokens: 16 },
    });
    const sent = jsonBody(f.calls.at(-1) as { body: unknown });
    expect(sent).toMatchObject({
      model: 'qwen2.5:0.5b',
      stream: false,
      keep_alive: '30m',
      options: { num_predict: 64, temperature: 0 },
    });
    expect(sent.format).toBeUndefined();
  });

  it('sends keep_alive as a number when OLLAMA_KEEP_ALIVE is numeric', async () => {
    const base = 'http://ollama-keep:11434';
    const f = ollama(base, 'ollama-chat.json');
    await ollamaChat({ base, model: 'qwen2.5:0.5b', keepAlive: '-1' }, question, testContext({ fetch: f }));
    expect(jsonBody(f.calls.at(-1) as { body: unknown }).keep_alive).toBe(-1);
  });

  it('uses format "json" for plain JSON mode', async () => {
    const base = 'http://ollama-json:11434';
    const f = ollama(base, 'ollama-chat-json.json');
    const res = await ollamaChat({ base, model: 'qwen2.5:0.5b' }, { ...question, json: true }, testContext({ fetch: f }));
    expect(JSON.parse(res.text)).toEqual({ year: 1969, mission: 'Apollo 11' });
    const sent = jsonBody(f.calls.at(-1) as { body: unknown });
    expect(sent.format).toBe('json');
    expect((sent.messages as { role: string }[])[0]?.role).toBe('system');
  });

  it('puts a JSON Schema in format on servers from 0.5.0', async () => {
    const base = 'http://ollama-schema:11434';
    const schema = {
      type: 'object',
      properties: { year: { type: 'number' }, mission: { type: 'string' } },
      required: ['year', 'mission'],
    };
    const f = ollama(base, 'ollama-chat-schema.json');
    const res = await ollamaChat({ base, model: 'qwen2.5:0.5b' }, { ...question, json: { schema } }, testContext({ fetch: f }));
    expect(JSON.parse(res.text)).toEqual({ year: 1969, mission: 'Apollo 11' });
    expect(jsonBody(f.calls.at(-1) as { body: unknown }).format).toEqual(schema);
  });

  it('turns a missing model into not-found with a pull hint', async () => {
    const base = 'http://ollama-missing:11434';
    const f = replayFetch([{ method: 'POST', url: `${base}/api/show`, response: bodyWithStatus('ollama-show-missing.txt') }]);
    const err = await ollamaChat({ base, model: 'llama3.3:70b' }, question, testContext({ fetch: f })).catch((e) => e);
    expect(err.code).toBe('not-found');
    expect(err.hint).toContain('ollama pull llama3.3:70b');
  });
});

describe('stream', () => {
  it('parses the NDJSON stream into deltas and one done', async () => {
    const base = 'http://ollama-stream:11434';
    const f = ollama(base, 'ollama-chat-stream.ndjson');
    const events: ChatStreamEvent[] = await collect(
      ollamaStream({ base, model: 'qwen2.5:0.5b' }, question, testContext({ fetch: f })),
    );
    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.length).toBeGreaterThan(5);
    expect(deltas.join('')).toBe('Apollo 11 landed on the moon in 1969.');
    expect(events.at(-1)).toEqual({
      type: 'done',
      result: {
        text: 'Apollo 11 landed on the moon in 1969.',
        model: 'qwen2.5:0.5b',
        usage: { inputTokens: 47, outputTokens: 16 },
      },
    });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(jsonBody(f.calls.at(-1) as { body: unknown }).stream).toBe(true);
  });
});
