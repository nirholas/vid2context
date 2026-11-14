import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, type LlmRung, rankRungs } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { buildBody, llmRungs } from '../src/index.ts';

// Real recordings from OVH AI Endpoints and Pollinations, 2026-11-14 (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const OVH = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
const POLLINATIONS = 'https://text.pollinations.ai/openai';

function rungById(id: string, env = {}): LlmRung {
  const r = llmRungs(env).find((x) => x.id === id);
  if (!r) throw new Error(`no rung ${id}`);
  return r;
}

const question = {
  messages: [{ role: 'user' as const, content: 'Which year did Apollo 11 land on the moon? Use keys year and mission.' }],
  maxTokens: 200,
};

describe('rungs from env', () => {
  it('runs the keyless lanes with zero configuration', () => {
    expect(rankRungs(llmRungs({}), {}, {}).map((r) => r.id)).toEqual([
      'llm/ovh/Meta-Llama-3_3-70B-Instruct',
      'llm/ovh/gpt-oss-120b',
      'llm/pollinations/openai-fast',
    ]);
  });

  it('orders free (per model, step-downs last), keyless, paid', () => {
    const env = {
      GROQ_API_KEY: 'gsk_a',
      CEREBRAS_API_KEY: 'csk_a',
      OPENAI_API_KEY: 'sk-a',
      VID2CONTEXT_KEYLESS: '0',
    };
    expect(rankRungs(llmRungs(env), {}, env).map((r) => r.id)).toEqual([
      'llm/groq/qwen/qwen3.8-27b',
      'llm/groq/openai/gpt-oss-120b',
      'llm/cerebras/gpt-oss-120b',
      'llm/cerebras/llama-3.3-70b',
      'llm/groq/openai/gpt-oss-20b',
      'llm/openai/gpt-5.4-nano',
    ]);
  });

  it('replaces a lane model list from <PROVIDER>_MODEL and pools extra keys', () => {
    const env = { GROQ_API_KEY: 'gsk_a', GROQ_FALLBACK_KEYS: 'gsk_b', GROQ_MODEL: 'openai/gpt-oss-120b' };
    expect(rankRungs(llmRungs(env), { only: ['groq', 'groq#2'] }, env).map((r) => r.id)).toEqual([
      'llm/groq/openai/gpt-oss-120b',
      'llm/groq#2/openai/gpt-oss-120b',
    ]);
  });

  it('flags structured output support', () => {
    expect(rungById('llm/gemini/gemini-2.5-flash-lite').capabilities).toEqual(['json', 'json-schema']);
    expect(rungById('llm/github/meta/Llama-3.3-70B-Instruct').capabilities).toEqual([]);
  });
});

describe('request bodies', () => {
  it('asks for json_object with the schema in the prompt when strict schemas are unsupported', () => {
    const schema = { type: 'object', properties: { year: { type: 'number' } }, required: ['year'] };
    const body = buildBody({ url: OVH, model: 'm', label: 'ovh' }, { ...question, json: { schema } });
    expect(body.response_format).toEqual({ type: 'json_object' });
    const msgs = body.messages as { role: string; content: string }[];
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toContain('"required":["year"]');
  });

  it('uses json_schema where supported', () => {
    const schema = { type: 'object', properties: {} };
    const body = buildBody(
      { url: OVH, model: 'm', label: 'x', jsonSchema: true },
      { ...question, json: { schema, name: 'answer' } },
    );
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } });
  });
});

describe('chat (recorded responses)', () => {
  it('answers in JSON mode on keyless OVH without an Authorization header', async () => {
    const fetch = replayFetch([{ method: 'POST', url: OVH, response: { body: fixture('ovh-llama-3.3-70b.json-object.json') } }]);
    const res = await rungById('llm/ovh/Meta-Llama-3_3-70B-Instruct').chat({ ...question, json: true }, testContext({ fetch }));
    expect(JSON.parse(res.text)).toEqual({ year: 1969, mission: 'Apollo 11' });
    expect(res.usage).toEqual({ inputTokens: 59, outputTokens: 16 });
    expect(fetch.calls[0]?.headers.authorization).toBeUndefined();
  });

  it('returns only the answer from reasoning models', async () => {
    const ovh = replayFetch([{ url: OVH, response: { body: fixture('ovh-gpt-oss-120b.json') } }]);
    const a = await rungById('llm/ovh/gpt-oss-120b').chat(question, testContext({ fetch: ovh }));
    expect(a.text).toBe('Apollo\u202f11 landed on the Moon in 1969.');
    const poll = replayFetch([{ url: POLLINATIONS, response: { body: fixture('pollinations-openai-fast.json-object.json') } }]);
    const b = await rungById('llm/pollinations/openai-fast').chat({ ...question, json: true }, testContext({ fetch: poll }));
    expect(b).toMatchObject({ text: '{"year": 1969, "mission": "Apollo 11"}', model: 'gpt-oss-20b' });
  });

  it('treats an empty answer as a fall-through error', async () => {
    const empty = replayFetch([{ url: OVH, response: { body: fixture('ovh-gpt-oss-120b.empty-length.json') } }]);
    const err = await rungById('llm/ovh/gpt-oss-120b')
      .chat({ ...question, maxTokens: 5 }, testContext({ fetch: empty }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'upstream', hint: 'The model spent its token budget on reasoning; raise maxTokens.' });
  });
});

describe.skipIf(!process.env.LIVE)('keyless chat (live)', () => {
  it('gets an answer from a keyless lane through the chain order', async () => {
    const ctx = createContext({ runtime: 'node', env: process.env });
    const res = await rungById('llm/pollinations/openai-fast').chat(question, ctx);
    expect(res.text).toMatch(/1969/);
  });
});
