import { canStream, rankRungs } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import provider, { localRungs } from '../src/index.ts';
import { showModel } from '../src/ollama.ts';
import { fixture } from './helpers.ts';

const enabled = (env: Record<string, string>) => localRungs(env).filter((r) => r.isEnabled?.(env) ?? true);

describe('rungs from env', () => {
  it('is local tier, node and browser, and has nothing enabled without env', () => {
    expect(provider.id).toBe('llm-local');
    expect(provider.runtimes).toEqual(['node', 'browser']);
    const all = localRungs({});
    expect(all.map((r) => r.id)).toEqual([
      'llm/ollama',
      'llm/lmstudio',
      'llm/llamacpp',
      'llm/vllm',
      'llm/jan',
      'llm/localai',
      'llm/local',
    ]);
    expect(all.every((r) => r.tier === 'local' && r.isEnabled?.({}) === false)).toBe(true);
    expect(all.find((r) => r.service === 'local')?.requires).toEqual(['LOCAL_LLM_MODEL', 'LOCAL_LLM_BASE_URL']);
  });

  it('keeps every foundation variable working with the same rung ids', () => {
    const env = {
      OLLAMA_MODEL: 'qwen3:8b',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1',
      LMSTUDIO_MODEL: 'qwen2.5-7b-instruct',
      LMSTUDIO_BASE_URL: 'http://localhost:1234/v1',
      LOCAL_LLM_BASE_URL: 'http://localhost:8080/v1',
      LOCAL_LLM_MODEL: 'any-gguf',
      LOCAL_LLM_API_KEY: 'k',
    };
    expect(rankRungs(localRungs(env), { policy: 'local-only' }, env).map((r) => r.id)).toEqual([
      'llm/ollama/qwen3:8b',
      'llm/lmstudio/qwen2.5-7b-instruct',
      'llm/local/any-gguf',
    ]);
  });

  it('adds llama.cpp, vLLM, Jan and LocalAI, one rung per listed model, in order', () => {
    const env = {
      OLLAMA_MODEL: 'qwen2.5:7b, qwen2.5:0.5b',
      LLAMACPP_MODEL: 'qwen2.5-0.5b-instruct-q4_k_m',
      VLLM_MODEL: 'Qwen/Qwen2.5-7B-Instruct',
      JAN_MODEL: 'llama3.2-3b-instruct',
      LOCALAI_MODEL: 'gpt-4',
    };
    expect(enabled(env).map((r) => r.id)).toEqual([
      'llm/ollama/qwen2.5:7b',
      'llm/ollama/qwen2.5:0.5b',
      'llm/llamacpp/qwen2.5-0.5b-instruct-q4_k_m',
      'llm/vllm/Qwen/Qwen2.5-7B-Instruct',
      'llm/jan/llama3.2-3b-instruct',
      'llm/localai/gpt-4',
    ]);
    expect(enabled(env).every(canStream)).toBe(true);
    const caps = Object.fromEntries(enabled(env).map((r) => [r.service, r.capabilities]));
    expect(caps.llamacpp).toEqual(['json', 'json-schema']);
    expect(caps.jan).toEqual([]);
  });

  it('a generic local server needs LOCAL_LLM_BASE_URL as well as the model', () => {
    expect(enabled({ LOCAL_LLM_MODEL: 'x' })).toEqual([]);
  });

  it('adds capabilities and the context length once /api/show has been read', async () => {
    const base = 'http://ollama-caps:11434';
    const f = replayFetch([{ method: 'POST', url: `${base}/api/show`, response: { body: fixture('ollama-show-qwen2.5-3b.json') } }]);
    const env = { OLLAMA_MODEL: 'qwen2.5:3b', OLLAMA_BASE_URL: base };
    expect(enabled(env)[0]?.contextTokens).toBeUndefined();
    await showModel(base, 'qwen2.5:3b', testContext({ fetch: f }));
    const r = enabled(env)[0];
    expect(r?.contextTokens).toBe(32768);
    expect(r?.capabilities).toEqual(['json', 'json-schema', 'tools']);
  });
});
