import llmOpenAiCompatible from '@vid2context/provider-llm-openai-compatible';
import { describe, expect, it } from 'vitest';
import { groupModels, listModels, modelLabel } from '../../src/llm/models.ts';
import { Registry } from '../../src/registry.ts';

// The foundation's real llm provider (every OpenAI-compatible lane).
const registry = new Registry([llmOpenAiCompatible], 'node');

describe('listModels', () => {
  it('lists every llm rung with every ModelInfo field, enabled or not', () => {
    const models = listModels(registry, {}, { kind: 'llm' });
    expect(models.length).toBe(llmOpenAiCompatible.rungs({}).length);
    const ovh = models.find((m) => m.id === 'llm/ovh/gpt-oss-120b');
    expect(ovh).toEqual({
      id: 'llm/ovh/gpt-oss-120b',
      kind: 'llm',
      label: 'gpt-oss-120b',
      service: 'ovh',
      provider: 'llm-openai-compatible',
      model: 'gpt-oss-120b',
      tier: 'keyless',
      quality: 4,
      capabilities: ['json', 'stream'],
      contextTokens: 131_072,
      enabled: true,
      requires: [],
    });
    const groq = models.find((m) => m.id === 'llm/groq/openai/gpt-oss-120b');
    expect(groq).toMatchObject({ label: 'gpt-oss-120b', enabled: false, requires: ['GROQ_API_KEY'], tier: 'free' });
    expect(models.filter((m) => m.enabled).map((m) => m.id)).toEqual([
      'llm/ovh/Meta-Llama-3_3-70B-Instruct',
      'llm/ovh/gpt-oss-120b',
      'llm/pollinations/openai-fast',
    ]);
  });

  it('sorts by the default free-first order: local, free, keyless, paid', () => {
    const tiers = listModels(registry, {}, { kind: 'llm' }).map((m) => m.tier);
    const order = ['local', 'free', 'keyless', 'paid'];
    expect([...tiers].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(tiers);
    expect(new Set(tiers)).toEqual(new Set(order));
  });

  it('a Groq key enables the Groq rungs, ordered by priority', () => {
    const env = { GROQ_API_KEY: 'gsk_a' };
    const models = listModels(registry, env, { kind: 'llm' });
    const free = models.filter((m) => m.tier === 'free' && m.enabled).map((m) => m.id);
    expect(free).toEqual(['llm/groq/qwen/qwen3.8-27b', 'llm/groq/openai/gpt-oss-120b', 'llm/groq/openai/gpt-oss-20b']);
    expect(models.find((m) => m.id === 'llm/cerebras/gpt-oss-120b')?.enabled).toBe(false);
  });

  it('VID2CONTEXT_KEYLESS=0 turns keyless rungs off but still lists them', () => {
    const models = listModels(registry, { VID2CONTEXT_KEYLESS: '0' }, { kind: 'llm' });
    const keyless = models.filter((m) => m.tier === 'keyless');
    expect(keyless.length).toBe(3);
    expect(keyless.every((m) => !m.enabled)).toBe(true);
  });

  it('VID2CONTEXT_ALLOW_PAID=0 turns paid rungs off even with their key', () => {
    const on = listModels(registry, { OPENAI_API_KEY: 'sk-a' }, { kind: 'llm' }).find((m) => m.tier === 'paid');
    const off = listModels(registry, { OPENAI_API_KEY: 'sk-a', VID2CONTEXT_ALLOW_PAID: '0' }, { kind: 'llm' }).find(
      (m) => m.tier === 'paid',
    );
    expect(on?.enabled).toBe(true);
    expect(off?.enabled).toBe(false);
  });

  it('marks every streaming rung with the stream capability', () => {
    const models = listModels(registry, {}, { kind: 'llm' });
    expect(models.every((m) => m.capabilities.includes('stream'))).toBe(true);
  });

  it('never puts an env value in the output', () => {
    const env = {
      GROQ_API_KEY: 'gsk_a_value_that_must_not_leak',
      GROQ_FALLBACK_KEYS: 'gsk_second_value_that_must_not_leak',
      OPENAI_API_KEY: 'sk-value-that-must-not-leak',
      OLLAMA_BASE_URL: 'http://10.1.2.3:11434/v1',
    };
    const out = JSON.stringify(listModels(registry, env));
    for (const v of Object.values(env)) expect(out).not.toContain(v);
    expect(out).toContain('GROQ_FALLBACK_KEYS');
  });

  it('returns nothing for kinds this registry has no rungs for', () => {
    expect(listModels(registry, {}, { kind: 'stt' })).toEqual([]);
  });
});

describe('labels and groups', () => {
  it('drops vendor prefixes from labels', () => {
    expect(modelLabel('openai/gpt-oss-120b', 'groq')).toBe('gpt-oss-120b');
    expect(modelLabel('@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'cloudflare')).toBe('llama-3.3-70b-instruct-fp8-fast');
    expect(modelLabel('', 'ollama')).toBe('ollama');
  });

  it('groups by tier, then service', () => {
    const groups = groupModels(listModels(registry, { GROQ_API_KEY: 'gsk_a', GROQ_FALLBACK_KEYS: 'gsk_b' }, { kind: 'llm' }));
    expect(groups.map((g) => g.tier)).toEqual(['local', 'free', 'keyless', 'paid']);
    const free = groups.find((g) => g.tier === 'free');
    expect(free?.services.map((s) => s.service)).toEqual(['groq', 'groq#2', 'cerebras', 'mistral', 'github', 'gemini']);
    expect(groups.find((g) => g.tier === 'keyless')?.services.map((s) => s.service)).toEqual(['ovh', 'pollinations']);
  });
});
