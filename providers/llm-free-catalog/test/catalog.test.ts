import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, type Env, type LlmRung, rankRungs, Vid2ContextError } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { llmRungs as foundationRungs } from '@vid2context/provider-llm-openai-compatible';
import { openrouterRungs } from '@vid2context/provider-llm-openrouter';
import { describe, expect, it } from 'vitest';
import { catalogRungs, chatVia, limitRequest, retryAfterFromHeaders } from '../src/index.ts';

// Real recordings, 2026-11-14 (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const KILO = 'https://api.kilo.ai/api/gateway/chat/completions';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const OTHER_ACCOUNT = 'fedcba9876543210fedcba9876543210';
const cfUrl = (id: string) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1/chat/completions`;

function rung(id: string, env: Env = {}): LlmRung {
  const r = catalogRungs(env).find((x) => x.id === id);
  if (!r) throw new Error(`no rung ${id}; have ${catalogRungs(env).map((x) => x.id)}`);
  return r;
}

function bodyOf(call: { body: unknown }): Record<string, unknown> {
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

const question = {
  messages: [{ role: 'user' as const, content: 'Which year did Apollo 11 land on the moon? Answer with the year only.' }],
  maxTokens: 200,
};

const ALL_KEYS: Env = {
  KILO_API_KEY: 'kilo_a',
  NVIDIA_API_KEY: 'nvapi-a',
  SAMBANOVA_API_KEY: 'sn_a',
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_API_TOKEN: 'cf_a',
  ZHIPU_API_KEY: 'zp_a',
  SILICONFLOW_API_KEY: 'sf_a',
  OPENROUTER_API_KEY: 'sk-or-a',
  GROQ_API_KEY: 'gsk_a',
  CEREBRAS_API_KEY: 'csk_a',
  MISTRAL_API_KEY: 'ms_a',
  GITHUB_TOKEN: 'ghp_a',
  GEMINI_API_KEY: 'gm_a',
  OPENAI_API_KEY: 'sk-a',
  OLLAMA_MODEL: 'qwen3:8b',
};

describe('rungs from env', () => {
  it('runs only the Kilo keyless lane with zero configuration and lists the rest with what they need', () => {
    const rungs = catalogRungs({});
    expect(rankRungs(rungs, {}, {}).map((r) => r.id)).toEqual([
      'llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
      'llm/kilo/nvidia/nemotron-3.5-super-vl:free',
      'llm/kilo/nvidia/nemotron-3.5-lightning:free',
    ]);
    const disabled = Object.fromEntries(rungs.filter((r) => r.tier === 'free').map((r) => [r.id, r.requires]));
    expect(disabled).toEqual({
      'llm/nvidia/nvidia/nemotron-3-super-120b-a12b': ['NVIDIA_API_KEY'],
      'llm/sambanova/Meta-Llama-3.3-70B-Instruct': ['SAMBANOVA_API_KEY'],
      'llm/cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast': ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
      'llm/zhipu/glm-4.7-flash': ['ZHIPU_API_KEY'],
      'llm/siliconflow/Qwen/Qwen3-8B': ['SILICONFLOW_API_KEY'],
    });
  });

  it('puts Kilo ahead of the foundation keyless lanes, and VID2CONTEXT_KEYLESS=0 drops it', () => {
    const all = [...foundationRungs({}), ...catalogRungs({})];
    expect(rankRungs(all, {}, {}).map((r) => r.service)).toEqual(['kilo', 'kilo', 'kilo', 'ovh', 'ovh', 'pollinations']);
    expect(rankRungs(all, {}, { VID2CONTEXT_KEYLESS: '0' })).toEqual([]);
  });

  it('places the new free lanes among the foundation free lanes', () => {
    const env = { ...ALL_KEYS, VID2CONTEXT_KEYLESS: '0' };
    const all = [...foundationRungs(env), ...catalogRungs(env), ...openrouterRungs(env)];
    expect(rankRungs(all, { allowPaid: false, skip: ['ollama'] }, env).map((r) => r.service)).toEqual([
      'groq',
      'groq',
      'cerebras',
      'cerebras',
      'openrouter',
      'nvidia',
      'kilo',
      'kilo',
      'kilo',
      'sambanova',
      'cloudflare',
      'mistral',
      'zhipu',
      'github',
      'gemini',
      'siliconflow',
      'groq',
    ]);
  });

  it('never produces a rung id the foundation or OpenRouter packages produce', () => {
    const envs: Env[] = [
      {},
      ALL_KEYS,
      { ...ALL_KEYS, GROQ_FALLBACK_KEYS: 'gsk_b', NVIDIA_FALLBACK_KEYS: 'nvapi-b,nvapi-c', KILO_FALLBACK_KEYS: 'kilo_b' },
      { ...ALL_KEYS, NVIDIA_MODEL: 'openai/gpt-oss-120b', CEREBRAS_MODEL: 'gpt-oss-120b', KILO_MODEL: 'openai/gpt-oss-120b' },
      { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'cf_a', CLOUDFLARE_FALLBACK_KEYS: `${OTHER_ACCOUNT}:cf_b` },
    ];
    for (const env of envs) {
      const ids = [...foundationRungs(env), ...catalogRungs(env), ...openrouterRungs(env)].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('replaces a model list from <PROVIDER>_MODEL and adds one rung per pooled key', () => {
    const env = {
      NVIDIA_API_KEY: 'nvapi-a',
      NVIDIA_FALLBACK_KEYS: 'nvapi-b, nvapi-a',
      NVIDIA_MODEL: 'nvidia/nemotron-3-ultra-550b-a55b,nvidia/nemotron-3-super-120b-a12b',
    };
    const nv = catalogRungs(env).filter((r) => r.service.startsWith('nvidia'));
    expect(nv.map((r) => [r.id, r.requires, r.priority, r.quality])).toEqual([
      ['llm/nvidia/nvidia/nemotron-3-ultra-550b-a55b', ['NVIDIA_API_KEY'], 30, 3],
      ['llm/nvidia/nvidia/nemotron-3-super-120b-a12b', ['NVIDIA_API_KEY'], 31, 4],
      ['llm/nvidia#2/nvidia/nemotron-3-ultra-550b-a55b', ['NVIDIA_FALLBACK_KEYS'], 30, 3],
      ['llm/nvidia#2/nvidia/nemotron-3-super-120b-a12b', ['NVIDIA_FALLBACK_KEYS'], 31, 4],
    ]);
    expect(nv.every((r) => r.isEnabled?.(env))).toBe(true);
  });

  it('turns Kilo into a free rung with a key, and a non-free model with a key into a paid rung', () => {
    const env = { KILO_API_KEY: 'kilo_a', KILO_MODEL: 'nvidia/nemotron-3-ultra-550b-a55b:free,anthropic/claude-sonnet-5' };
    expect(catalogRungs(env).map((r) => [r.id, r.tier, r.requires])).toContainEqual([
      'llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
      'free',
      ['KILO_API_KEY'],
    ]);
    expect(rung('llm/kilo/anthropic/claude-sonnet-5', env).tier).toBe('paid');
    expect(rung('llm/kilo/anthropic/claude-sonnet-5', { KILO_MODEL: 'anthropic/claude-sonnet-5' }).tier).toBe('keyless');
  });

  it('builds Cloudflare rungs per account and needs both the account id and a token', () => {
    expect(
      rung('llm/cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast', { CLOUDFLARE_API_TOKEN: 'cf_a' }).isEnabled?.({}),
    ).toBe(false);
    const env = {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_API_TOKEN: 'cf_a',
      CLOUDFLARE_FALLBACK_KEYS: `${OTHER_ACCOUNT}:cf_b`,
    };
    const cf = catalogRungs(env).filter((r) => r.service.startsWith('cloudflare'));
    expect(cf.map((r) => [r.id, r.requires, r.isEnabled?.(env)])).toEqual([
      ['llm/cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast', ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'], true],
      ['llm/cloudflare#2/@cf/meta/llama-3.3-70b-instruct-fp8-fast', ['CLOUDFLARE_FALLBACK_KEYS'], true],
    ]);
    expect(cf[0]?.capabilities).toEqual(['json', 'json-schema']);
  });

  it('flags JSON only where it was verified live', () => {
    const caps = Object.fromEntries(catalogRungs(ALL_KEYS).map((r) => [r.id, r.capabilities]));
    expect(caps['llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free']).toEqual(['json']);
    expect(caps['llm/kilo/nvidia/nemotron-3.5-super-vl:free']).toEqual([]);
    expect(caps['llm/nvidia/nvidia/nemotron-3-super-120b-a12b']).toEqual([]);
    expect(caps['llm/zhipu/glm-4.7-flash']).toEqual([]);
  });
});

describe('requests', () => {
  it('sends no Authorization header to keyless Kilo and keeps reasoning out of the answer', async () => {
    const fetch = replayFetch([{ method: 'POST', url: KILO, response: { body: fixture('kilo-nemotron-3-ultra.json') } }]);
    const res = await rung('llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free').chat(question, testContext({ fetch }));
    expect(res).toEqual({
      text: '1969',
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      usage: { inputTokens: 34, outputTokens: 5 },
    });
    const call = fetch.calls[0] as (typeof fetch.calls)[number];
    expect(call.headers.authorization).toBeUndefined();
    expect(bodyOf(call)).toMatchObject({ reasoning: { enabled: false }, max_tokens: 200 });
  });

  it('sends the Kilo key when one is set', async () => {
    const env = { KILO_API_KEY: 'kilo_a' };
    const fetch = replayFetch([{ method: 'POST', url: KILO, response: { body: fixture('kilo-nemotron-3-ultra.json') } }]);
    await rung('llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free', env).chat(question, testContext({ fetch, env }));
    expect(fetch.calls[0]?.headers.authorization).toBe('Bearer kilo_a');
  });

  it('strips a separate reasoning field from the answer', async () => {
    const fetch = replayFetch([{ url: KILO, response: { body: fixture('kilo-nemotron-3.5-super-vl.reasoning.json') } }]);
    const res = await rung('llm/kilo/nvidia/nemotron-3.5-super-vl:free').chat(question, testContext({ fetch }));
    expect(res.text).toBe('1969');
  });

  it('reads a JSON-mode answer from Kilo', async () => {
    const fetch = replayFetch([{ url: KILO, response: { body: fixture('kilo-nemotron-3-ultra.json-object.json') } }]);
    const res = await rung('llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free').chat(
      { ...question, json: true },
      testContext({ fetch }),
    );
    expect(JSON.parse(res.text)).toEqual({ year: 1969, mission: 'Apollo 11' });
    expect(bodyOf(fetch.calls[0] as { body: unknown }).response_format).toEqual({ type: 'json_object' });
  });

  it('calls Cloudflare per account with strict JSON Schema and a default output length', async () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'cf_a' };
    const fetch = replayFetch([
      { url: cfUrl(ACCOUNT), response: { body: fixture('cloudflare-llama-3.3-70b.json-schema.json') } },
    ]);
    const schema = {
      type: 'object',
      properties: { year: { type: 'number' }, mission: { type: 'string' } },
      required: ['year', 'mission'],
    };
    const res = await rung('llm/cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast', env).chat(
      { messages: question.messages, json: { schema, name: 'answer' } },
      testContext({ fetch, env }),
    );
    expect(JSON.parse(res.text)).toEqual({ year: 1969, mission: 'Apollo 11' });
    const call = fetch.calls[0] as (typeof fetch.calls)[number];
    expect(call.headers.authorization).toBe('Bearer cf_a');
    const body = bodyOf(call);
    expect(body.max_tokens).toBe(2048);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } });
  });

  it('routes a pooled Cloudflare entry to its own account', async () => {
    const env = {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_API_TOKEN: 'cf_a',
      CLOUDFLARE_FALLBACK_KEYS: `${OTHER_ACCOUNT}:cf_b`,
    };
    const fetch = replayFetch([{ url: cfUrl(OTHER_ACCOUNT), response: { body: fixture('cloudflare-llama-3.3-70b.json') } }]);
    const res = await rung('llm/cloudflare#2/@cf/meta/llama-3.3-70b-instruct-fp8-fast', env).chat(
      question,
      testContext({ fetch, env }),
    );
    expect(res.text).toBe('1969');
    expect(fetch.calls[0]?.headers.authorization).toBe('Bearer cf_b');
  });

  it('adds the per-service body fields and limits', () => {
    expect(
      limitRequest(
        { messages: [], maxTokens: 8000, temperature: 1.6 },
        { maxOutputTokens: 3072, temperature: { min: 0, max: 1 } },
      ),
    ).toEqual({ messages: [], maxTokens: 3072, temperature: 1 });
    expect(limitRequest({ messages: [] }, { defaultMaxTokens: 2048 })).toEqual({ messages: [], maxTokens: 2048 });
    expect(limitRequest({ messages: [], maxTokens: 10 }, undefined)).toEqual({ messages: [], maxTokens: 10 });
  });

  it('sends the thinking switches and the SambaNova output cap', async () => {
    const env = { NVIDIA_API_KEY: 'nvapi-a', SAMBANOVA_API_KEY: 'sn_a', ZHIPU_API_KEY: 'zp_a', SILICONFLOW_API_KEY: 'sf_a' };
    const fetch = replayFetch([
      { url: /nvidia/, response: { status: 401, body: fixture('nvidia-401.json') } },
      { url: /sambanova/, response: { status: 401, body: fixture('sambanova-401.json') } },
      { url: /z\.ai/, response: { status: 401, body: fixture('zhipu-401.json') } },
      { url: /siliconflow/, response: { status: 401, body: fixture('siliconflow-401.json') } },
    ]);
    const ctx = testContext({ fetch, env });
    const req = { ...question, maxTokens: 8000, temperature: 1.5 };
    for (const id of [
      'llm/nvidia/nvidia/nemotron-3-super-120b-a12b',
      'llm/sambanova/Meta-Llama-3.3-70B-Instruct',
      'llm/zhipu/glm-4.7-flash',
      'llm/siliconflow/Qwen/Qwen3-8B',
    ]) {
      await expect(rung(id, env).chat(req, ctx)).rejects.toMatchObject({ code: 'auth', status: 401 });
    }
    const [nv, sn, zp, sf] = fetch.calls.map(bodyOf);
    expect(fetch.calls.map((c) => c.url)).toEqual([
      'https://integrate.api.nvidia.com/v1/chat/completions',
      'https://api.sambanova.ai/v1/chat/completions',
      'https://api.z.ai/api/paas/v4/chat/completions',
      'https://api.siliconflow.com/v1/chat/completions',
    ]);
    expect(nv).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, temperature: 1, max_tokens: 8000 });
    expect(sn).toMatchObject({ max_tokens: 3072, temperature: 1 });
    expect(zp).toMatchObject({ thinking: { type: 'disabled' }, temperature: 1 });
    expect(sf).toMatchObject({ enable_thinking: false, temperature: 1.5 });
  });

  it('honours <PROVIDER>_BASE_URL overrides', async () => {
    const env = { ZHIPU_API_KEY: 'zp_a', ZHIPU_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4/' };
    const fetch = replayFetch([{ url: /bigmodel/, response: { status: 401, body: fixture('zhipu-401.json') } }]);
    await expect(rung('llm/zhipu/glm-4.7-flash', env).chat(question, testContext({ fetch, env }))).rejects.toThrow();
    expect(fetch.calls[0]?.url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
  });
});

describe('errors', () => {
  it('maps a retired Kilo model to not-found and a bad Cloudflare token to auth', async () => {
    const fetch = replayFetch([
      { url: KILO, response: { status: 404, body: fixture('kilo-404-retired-model.json') } },
      { url: cfUrl(ACCOUNT), response: { status: 401, body: fixture('cloudflare-401.json') } },
    ]);
    const env = {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_API_TOKEN: 'cf_bad',
      KILO_MODEL: 'nvidia/nemotron-3-super-120b-a12b:free',
    };
    const ctx = testContext({ fetch, env });
    const kilo = rung('llm/kilo/nvidia/nemotron-3-super-120b-a12b:free', env).chat(question, ctx);
    await expect(kilo).rejects.toMatchObject({ code: 'not-found', status: 404 });
    const cf = rung('llm/cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast', env).chat(question, ctx);
    await expect(cf).rejects.toMatchObject({ code: 'auth', status: 401 });
  });

  it('keeps Retry-After on a real 429', async () => {
    const OVH = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
    const headers = {
      'retry-after': '20',
      'ratelimit-reset': '20',
      'ratelimit-limit': '2',
      'ratelimit-remaining': '0',
      'x-ratelimit-limit-minute': '2',
      'x-ratelimit-remaining-minute': '0',
    };
    const fetch = replayFetch([{ url: OVH, response: { status: 429, headers, body: fixture('ovh-429.json') } }]);
    const err = await chatVia(
      { url: OVH, model: 'Meta-Llama-3_3-70B-Instruct', label: 'ovh' },
      question,
      testContext({ fetch }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err).toMatchObject({ code: 'rate-limited', status: 429, retryAfterSec: 20 });
  });

  it('reads a reset time from rate-limit headers when Retry-After is missing', () => {
    // OVH's 429 headers without Retry-After.
    expect(retryAfterFromHeaders(new Headers({ 'ratelimit-reset': '20', 'x-ratelimit-remaining-minute': '0' }))).toBe(20);
    expect(retryAfterFromHeaders(new Headers({ 'x-ratelimit-remaining-minute': '0' }))).toBeUndefined();
    const now = Date.UTC(2026, 10, 14, 17, 0, 0);
    expect(retryAfterFromHeaders(new Headers({ 'x-ratelimit-reset': String(now + 45_000) }), now)).toBe(45);
    expect(
      retryAfterFromHeaders(new Headers({ 'x-ratelimit-reset-requests': '2m59.56s', 'x-ratelimit-reset-tokens': '7.66s' })),
    ).toBe(180);
  });
});

describe.skipIf(!process.env.LIVE)('live', () => {
  const env = process.env as Env;
  const live = () => createContext({ runtime: 'node', env });

  it('Kilo answers keyless on every default model', async () => {
    for (const r of catalogRungs({}).filter((x) => x.service === 'kilo')) {
      const res = await r.chat(question, live());
      expect(res.text).toContain('1969');
    }
  });

  it.skipIf(!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)(
    'Cloudflare answers with the account token',
    async () => {
      const res = await rung('llm/cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast', env).chat(question, live());
      expect(res.text).toContain('1969');
    },
  );

  for (const [id, keyVar] of [
    ['llm/nvidia/nvidia/nemotron-3-super-120b-a12b', 'NVIDIA_API_KEY'],
    ['llm/sambanova/Meta-Llama-3.3-70B-Instruct', 'SAMBANOVA_API_KEY'],
    ['llm/zhipu/glm-4.7-flash', 'ZHIPU_API_KEY'],
    ['llm/siliconflow/Qwen/Qwen3-8B', 'SILICONFLOW_API_KEY'],
  ] as const) {
    it.skipIf(!process.env[keyVar])(`${id} answers with ${keyVar}`, async () => {
      const res = await rung(id, env).chat(question, live());
      expect(res.text).toContain('1969');
    });
  }
});
