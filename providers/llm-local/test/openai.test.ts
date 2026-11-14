import type { ChatStreamEvent } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { localRungs } from '../src/index.ts';
import { bodyWithStatus, collect, fixture, jsonBody } from './helpers.ts';

// Real responses from llama.cpp server b12383 (qwen2.5 0.5B Q4_K_M, -c 8192) on 2026-11-14.
const BASE = 'http://127.0.0.1:25080/v1';
const URL_CHAT = `${BASE}/chat/completions`;
const env = { LLAMACPP_BASE_URL: BASE, LLAMACPP_MODEL: 'qwen2.5-0.5b-instruct-q4_k_m' };
const rung = () => {
  const r = localRungs(env).find((x) => x.id === 'llm/llamacpp/qwen2.5-0.5b-instruct-q4_k_m');
  if (!r) throw new Error('no llama.cpp rung');
  return r;
};

const question = {
  messages: [{ role: 'user' as const, content: 'Which year did Apollo 11 land on the moon? Answer in one short sentence.' }],
  maxTokens: 64,
  temperature: 0,
};

describe('llama.cpp server (OpenAI-compatible)', () => {
  it('chats through chatWith', async () => {
    const f = replayFetch([{ method: 'POST', url: URL_CHAT, response: { body: fixture('llamacpp-chat.json') } }]);
    const res = await rung().chat(question, testContext({ fetch: f }));
    expect(res).toEqual({
      text: 'Apollo 11 landed on the moon in 1969.',
      model: 'qwen2.5-0.5b-instruct-q4_k_m',
      usage: { inputTokens: 47, outputTokens: 16 },
    });
  });

  it('streams SSE into deltas, usage and one done', async () => {
    const f = replayFetch([
      {
        method: 'POST',
        url: URL_CHAT,
        response: { headers: { 'content-type': 'text/event-stream' }, body: fixture('llamacpp-chat-stream.sse') },
      },
    ]);
    const events: ChatStreamEvent[] = await collect(rung().stream(question, testContext({ fetch: f })));
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Apollo 11 landed on the moon in 1969.');
    expect(events.at(-1)).toEqual({
      type: 'done',
      result: {
        text: 'Apollo 11 landed on the moon in 1969.',
        model: 'qwen2.5-0.5b-instruct-q4_k_m',
        usage: { inputTokens: 47, outputTokens: 16 },
      },
    });
    const sent = jsonBody(f.calls[0] as { body: unknown });
    expect(sent).toMatchObject({ stream: true, max_tokens: 64, model: 'qwen2.5-0.5b-instruct-q4_k_m' });
  });

  it('sends a strict JSON Schema', async () => {
    const schema = {
      type: 'object',
      properties: { year: { type: 'number' }, mission: { type: 'string' } },
      required: ['year', 'mission'],
    };
    const f = replayFetch([{ method: 'POST', url: URL_CHAT, response: { body: fixture('llamacpp-chat-schema.json') } }]);
    const res = await rung().chat({ ...question, json: { schema } }, testContext({ fetch: f }));
    expect(JSON.parse(res.text).year).toBe(1969);
    expect(jsonBody(f.calls[0] as { body: unknown }).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'result', schema, strict: true },
    });
  });

  it('turns the context overflow error into too-large, for chat and stream', async () => {
    const f = replayFetch([{ method: 'POST', url: URL_CHAT, response: bodyWithStatus('llamacpp-chat-too-large.txt') }]);
    const ctx = testContext({ fetch: f });
    const err = await rung()
      .chat(question, ctx)
      .catch((e) => e);
    expect(err.code).toBe('too-large');
    expect(err.message).toContain('exceeds the available context size');
    expect(err.hint).toContain('-c 32768');
    const streamErr = await collect(rung().stream(question, ctx)).catch((e) => e);
    expect(streamErr.code).toBe('too-large');
  });

  it('sends the optional API key as a bearer token', async () => {
    const f = replayFetch([{ method: 'POST', url: URL_CHAT, response: { body: fixture('llamacpp-chat.json') } }]);
    const keyed = localRungs({ ...env, LLAMACPP_API_KEY: 'local-secret' }).find((x) => x.service === 'llamacpp');
    await keyed?.chat(question, testContext({ fetch: f }));
    expect(f.calls[0]?.headers.authorization).toBe('Bearer local-secret');
  });
});
