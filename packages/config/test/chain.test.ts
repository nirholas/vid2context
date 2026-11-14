import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Env, rankRungs } from '@vid2context/core';
import { createRegistry } from '@vid2context/registry/node';
import { describe, expect, it } from 'vitest';
import { applyPrefer, chainOptionsFor, mergeEnv, parseConfig, resolveProfile, toEnv } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const load = (path: string) => parseConfig(readFileSync(path, 'utf8'), { source: path });
const examples = load(resolve(here, '../examples/vid2context.config.jsonc'));
const extended = load(resolve(here, 'fixtures/extends.jsonc'));

/**
 * Enables local, free, keyless and paid rungs. Values only switch rungs on:
 * ranking is pure and nothing here calls a service.
 */
const testEnv: Env = {
  OLLAMA_MODEL: 'qwen3:8b',
  LOCAL_STT_BASE_URL: 'http://localhost:8000/v1',
  LOCAL_STT_MODEL: 'Systran/faster-whisper-large-v3',
  GROQ_API_KEY: 'test-groq',
  CEREBRAS_API_KEY: 'test-cerebras',
  OPENAI_API_KEY: 'test-openai',
};

describe('chainOptionsFor', () => {
  const work = resolveProfile(extended, 'work');

  it('uses the stage value, else the default', () => {
    expect(chainOptionsFor('stt', work)).toEqual({
      policy: 'local-only',
      allowPaid: false,
      skip: ['pollinations'],
      prefer: ['cerebras', 'groq'],
    });
    expect(chainOptionsFor('llm', work)).toEqual({
      policy: 'quality',
      allowPaid: false,
      skip: ['pollinations', 'ovh'],
      prefer: ['cerebras', 'groq'],
    });
    expect(chainOptionsFor('embed', work)).toEqual({
      policy: 'free',
      allowPaid: false,
      only: ['ollama'],
      skip: ['pollinations'],
      prefer: ['cerebras', 'groq'],
    });
    expect(chainOptionsFor('video', work)).toEqual({
      policy: 'free',
      allowPaid: false,
      skip: ['pollinations'],
      prefer: ['cerebras', 'groq'],
    });
  });

  it('leaves global controls to the real env when it sets them, but keeps stage values', () => {
    const real = { VID2CONTEXT_POLICY: 'quality', VID2CONTEXT_ALLOW_PAID: '1', VID2CONTEXT_SKIP: 'ovh' };
    expect(chainOptionsFor('video', work, real)).toEqual({ prefer: ['cerebras', 'groq'] });
    expect(chainOptionsFor('stt', work, real)).toEqual({ policy: 'local-only', prefer: ['cerebras', 'groq'] });
  });

  it('per-stage hybrid example: local speech-to-text, hosted chat', () => {
    const hybrid = resolveProfile(examples, 'hybrid');
    const env = mergeEnv(testEnv, toEnv(examples, 'hybrid'));
    const registry = createRegistry();
    const stt = rankRungs(registry.sttRungs(env), chainOptionsFor('stt', hybrid), env);
    expect(stt.length).toBeGreaterThan(0);
    expect(stt.every((r) => r.tier === 'local')).toBe(true);
    const llmOpts = chainOptionsFor('llm', hybrid);
    const llm = applyPrefer(rankRungs(registry.llmRungs(env), llmOpts, env), llmOpts.prefer);
    expect(llm.some((r) => r.tier === 'free')).toBe(true);
    expect(llm.some((r) => r.tier === 'keyless' || r.tier === 'paid')).toBe(false);
    expect(llm[0]?.service).toBe('groq');
  });
});

describe('applyPrefer', () => {
  const registry = createRegistry();
  const ranked = rankRungs(registry.llmRungs(testEnv), {}, testEnv);

  it('moves preferred rungs to the front in prefer order and keeps the rest ranked', () => {
    const out = applyPrefer(ranked, ['cerebras', 'groq']);
    expect(out).toHaveLength(ranked.length);
    expect(new Set(out)).toEqual(new Set(ranked));
    const services = out.map((r) => r.service);
    const firstOther = services.findIndex((s) => s !== 'cerebras' && s !== 'groq');
    expect(services.slice(0, firstOther).every((s) => s === 'cerebras' || s === 'groq')).toBe(true);
    expect(services.lastIndexOf('cerebras')).toBeLessThan(services.indexOf('groq'));
    const rest = out.filter((r) => r.service !== 'cerebras' && r.service !== 'groq');
    expect(rest).toEqual(ranked.filter((r) => r.service !== 'cerebras' && r.service !== 'groq'));
  });

  it('matches rung ids too, and is a no-op for an empty list', () => {
    const target = ranked.at(-1);
    if (!target) throw new Error('no rungs ranked');
    expect(applyPrefer(ranked, [target.id])[0]).toBe(target);
    expect(applyPrefer(ranked, [])).toEqual(ranked);
  });
});

describe('end to end', () => {
  it('the private profile ranks only local LLM and STT rungs', () => {
    const env = mergeEnv(testEnv, toEnv(examples, 'private'));
    const registry = createRegistry();
    const llm = rankRungs(registry.llmRungs(env), {}, env);
    const stt = rankRungs(registry.sttRungs(env), {}, env);
    expect(llm.length).toBeGreaterThan(0);
    expect(llm.every((r) => r.tier === 'local')).toBe(true);
    expect(stt.every((r) => r.tier === 'local')).toBe(true);
    // The same env without the profile does rank hosted rungs.
    expect(rankRungs(registry.llmRungs(testEnv), {}, testEnv).some((r) => r.tier !== 'local')).toBe(true);
  });
});
