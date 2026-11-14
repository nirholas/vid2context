import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, type Env, type LlmRung, rankRungs } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBench, clearFreeModelCache, openrouterRungs, pickFreeModels, rankFreeModels, scoreModel } from '../src/index.ts';

// Real recordings from openrouter.ai, 2026-11-14 (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const MODELS = 'https://openrouter.ai/api/v1/models';
const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const RECORDED_AT = Date.UTC(2026, 10, 14, 17, 0, 0);
const models = JSON.parse(fixture('openrouter-models.json')) as { data: Parameters<typeof rankFreeModels>[0] };

const question = {
  messages: [{ role: 'user' as const, content: 'What is 17 plus 25? Reply with the number only.' }],
  maxTokens: 50,
};

function rung(id: string, env: Env): LlmRung {
  const r = openrouterRungs(env).find((x) => x.id === id);
  if (!r) throw new Error(`no rung ${id}`);
  return r;
}

beforeEach(() => {
  clearFreeModelCache();
  clearBench();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(RECORDED_AT);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('rungs from env', () => {
  it('lists a disabled free-auto rung without a key', () => {
    expect(openrouterRungs({}).map((r) => [r.id, r.tier, r.requires, r.isEnabled?.({})])).toEqual([
      ['llm/openrouter/free-auto', 'free', ['OPENROUTER_API_KEY'], false],
    ]);
  });

  it('adds one free-auto rung per pooled key and explicit rungs from OPENROUTER_MODEL', () => {
    const env = {
      OPENROUTER_API_KEY: 'sk-or-a',
      OPENROUTER_FALLBACK_KEYS: 'sk-or-b',
      OPENROUTER_MODEL: 'google/gemma-4-31b-it:free,anthropic/claude-haiku-4.5',
    };
    expect(openrouterRungs(env).map((r) => [r.id, r.tier, r.priority, r.requires])).toEqual([
      ['llm/openrouter/free-auto', 'free', 25, ['OPENROUTER_API_KEY']],
      ['llm/openrouter/google/gemma-4-31b-it:free', 'free', 26, ['OPENROUTER_API_KEY']],
      ['llm/openrouter/anthropic/claude-haiku-4.5', 'paid', 27, ['OPENROUTER_API_KEY']],
      ['llm/openrouter#2/free-auto', 'free', 25, ['OPENROUTER_FALLBACK_KEYS']],
      ['llm/openrouter#2/google/gemma-4-31b-it:free', 'free', 26, ['OPENROUTER_FALLBACK_KEYS']],
      ['llm/openrouter#2/anthropic/claude-haiku-4.5', 'paid', 27, ['OPENROUTER_FALLBACK_KEYS']],
    ]);
    expect(rankRungs(openrouterRungs(env), { allowPaid: false }, env).every((r) => r.tier === 'free')).toBe(true);
  });
});

describe('free model picker', () => {
  it('keeps only zero-priced :free text models with enough context, best first', () => {
    const ranked = rankFreeModels(models.data, RECORDED_AT / 1000);
    expect(ranked.map((m) => m.id)).toEqual([
      'nvidia/nemotron-3.5-super-vl:free',
      'nvidia/nemotron-3.5-lightning:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'inclusionai/ling-3.2-flash:free',
      'thinkingmachines/inkling-2-small:free',
      'baidu/ernie-5.5-flash-preview:free',
      'particle-ai/particle-1:free',
      'google/gemma-4-26b-a4b-it:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'google/gemma-4-31b-it:free',
      'dots-studio/dots-3-note-preview:free',
      'recursive/flint-v1.0:free',
      'cohere/north-mini-code:free',
      'liquid/lfm-3-1.7b:free',
    ]);
    const freeInList = models.data.filter((m) => m.id.endsWith(':free'));
    expect(ranked).toHaveLength(freeInList.length);
    expect(ranked.every((m) => m.id.endsWith(':free'))).toBe(true);
  });

  it('scores context, recency and family, and pushes tiny models down', () => {
    const now = RECORDED_AT / 1000;
    const base = { pricing: { prompt: '0', completion: '0' }, context_length: 262_144, created: now };
    expect(scoreModel({ id: 'google/gemma-x:free', ...base }, now)).toBeGreaterThan(
      scoreModel({ id: 'acme/x:free', ...base }, now),
    );
    expect(scoreModel({ id: 'acme/x-1.7b:free', ...base }, now)).toBeLessThan(
      scoreModel({ id: 'acme/x-70b:free', ...base }, now),
    );
    expect(scoreModel({ id: 'acme/x:free', ...base, created: now - 400 * 86_400 }, now)).toBeLessThan(
      scoreModel({ id: 'acme/x:free', ...base }, now),
    );
  });

  it('fetches the catalog once an hour', async () => {
    const fetch = replayFetch([{ method: 'GET', url: MODELS, response: { body: fixture('openrouter-models.json') } }]);
    const ctx = testContext({ fetch });
    const first = await pickFreeModels(ctx);
    expect(first[0]?.id).toBe('nvidia/nemotron-3.5-super-vl:free');
    await pickFreeModels(ctx);
    expect(fetch.calls).toHaveLength(1);
    vi.setSystemTime(RECORDED_AT + 61 * 60_000);
    await pickFreeModels(ctx);
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]?.headers.authorization).toBeUndefined();
  });
});

describe('free-auto chat', () => {
  const env = { OPENROUTER_API_KEY: 'sk-or-a' };

  it('falls through retired models to the next candidates, up to three, and remembers them', async () => {
    const fetch = replayFetch([
      { method: 'GET', url: MODELS, response: { body: fixture('openrouter-models.json') } },
      { method: 'POST', url: CHAT, response: { status: 404, body: fixture('openrouter-404.json') } },
    ]);
    const ctx = testContext({ fetch, env });
    await expect(rung('llm/openrouter/free-auto', env).chat(question, ctx)).rejects.toMatchObject({
      code: 'not-found',
      status: 404,
    });
    const tried = fetch.calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(String(c.body)).model);
    expect(tried).toEqual([
      'nvidia/nemotron-3.5-super-vl:free',
      'nvidia/nemotron-3.5-lightning:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    ]);
    const post = fetch.calls.find((c) => c.method === 'POST');
    expect(post?.headers).toMatchObject({
      authorization: 'Bearer sk-or-a',
      'http-referer': 'https://vid2context.com',
      'x-title': 'vid2context',
    });

    // The three retired candidates sit out, so the next call starts further down the list.
    await expect(rung('llm/openrouter/free-auto', env).chat(question, ctx)).rejects.toThrow();
    const next = fetch.calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(String(c.body)).model);
    expect(next.slice(3)).toEqual([
      'inclusionai/ling-3.2-flash:free',
      'thinkingmachines/inkling-2-small:free',
      'baidu/ernie-5.5-flash-preview:free',
    ]);
  });

  it('stops at an auth error instead of trying more models on the same key', async () => {
    let n = 0;
    const fetch = replayFetch([
      { method: 'GET', url: MODELS, response: { body: fixture('openrouter-models.json') } },
      {
        method: 'POST',
        url: CHAT,
        response: () =>
          n++ === 0
            ? { status: 404, body: fixture('openrouter-404.json') }
            : { status: 401, body: fixture('openrouter-401.json') },
      },
    ]);
    await expect(rung('llm/openrouter/free-auto', env).chat(question, testContext({ fetch, env }))).rejects.toMatchObject({
      code: 'auth',
      status: 401,
    });
    expect(fetch.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('sends explicit models as-is with the attribution headers', async () => {
    const e = { ...env, OPENROUTER_MODEL: 'google/gemma-4-31b-it:free', OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1/' };
    const fetch = replayFetch([{ method: 'POST', url: CHAT, response: { status: 401, body: fixture('openrouter-401.json') } }]);
    await expect(
      rung('llm/openrouter/google/gemma-4-31b-it:free', e).chat(question, testContext({ fetch, env: e })),
    ).rejects.toMatchObject({
      code: 'auth',
    });
    expect(JSON.parse(String(fetch.calls[0]?.body)).model).toBe('google/gemma-4-31b-it:free');
    expect(fetch.calls[0]?.headers['x-title']).toBe('vid2context');
  });
});

describe.skipIf(!process.env.LIVE)('live', () => {
  it('reads the live catalog and finds free models', async () => {
    vi.useRealTimers();
    const ranked = await pickFreeModels(createContext({ runtime: 'node', env: {} }));
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((m) => m.id.endsWith(':free'))).toBe(true);
  });

  it.skipIf(!process.env.OPENROUTER_API_KEY)('free-auto answers with a live free model', async () => {
    vi.useRealTimers();
    const env = process.env as Env;
    const res = await rung('llm/openrouter/free-auto', env).chat(question, createContext({ runtime: 'node', env }));
    expect(res.model).toMatch(/:free$/);
    expect(res.text).toContain('42');
  });
});
