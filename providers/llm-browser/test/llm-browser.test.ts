import { readFileSync } from 'node:fs';
import { canStream, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import provider, {
  browserAiEnv,
  CHROME_AI_MODEL,
  detectBrowserAi,
  newText,
  normalizeAvailability,
  recommendedWebLlmModels,
  smallestWebLlmModel,
  splitForPromptApi,
  toWebLlmMessages,
  WEBLLM_CONTEXT_TOKENS,
  webLlmModelsFromEnv,
} from '../src/index.ts';

const pkgRoot = new URL('../', import.meta.url);

describe('rungs', () => {
  it('lists WebLLM rungs and the Chrome rung, all disabled without env flags', () => {
    const rungs = provider.rungs({});
    expect(rungs.map((r) => r.id)).toEqual([
      ...recommendedWebLlmModels(true).map((m) => `llm/webllm/${m}`),
      `llm/chrome-ai/${CHROME_AI_MODEL}`,
    ]);
    for (const r of rungs) {
      expect(r.isEnabled?.({})).toBe(false);
      expect(r.tier).toBe('local');
      expect(r.provider).toBe('llm-browser');
      expect(r.capabilities).toEqual(['stream']);
      expect(canStream(r)).toBe(true);
    }
  });

  it('enables WebLLM rungs from WEBLLM_MODEL only, one rung per id', () => {
    const env = { WEBLLM_MODEL: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC, Llama-3.2-3B-Instruct-q4f16_1-MLC' };
    const rungs = provider.rungs(env).filter((r) => r.service === 'webllm');
    expect(rungs.map((r) => r.model)).toEqual(['Qwen2.5-1.5B-Instruct-q4f32_1-MLC', 'Llama-3.2-3B-Instruct-q4f16_1-MLC']);
    expect(rungs.every((r) => r.isEnabled?.(env))).toBe(true);
    expect(rungs.map((r) => r.priority)).toEqual([40, 41]);
    expect(rungs.map((r) => r.quality)).toEqual([2, 3]);
    expect(rungs[0]?.contextTokens).toBe(WEBLLM_CONTEXT_TOKENS);
    expect(rungs[0]?.requires).toEqual(['WEBLLM_MODEL']);
    expect(webLlmModelsFromEnv({ WEBLLM_MODEL: 'a,a, ,b' })).toEqual(['a', 'b']);
  });

  it('enables the Chrome rung from CHROME_AI only', () => {
    const chrome = provider.rungs({}).find((r) => r.service === 'chrome-ai');
    expect(chrome?.id).toBe('llm/chrome-ai/prompt-api');
    expect(chrome?.requires).toEqual(['CHROME_AI']);
    expect(chrome?.isEnabled?.({ CHROME_AI: '1' })).toBe(true);
    expect(chrome?.isEnabled?.({ CHROME_AI: 'true' })).toBe(true);
    expect(chrome?.isEnabled?.({ CHROME_AI: '0' })).toBe(false);
    expect(chrome?.isEnabled?.({ WEBLLM_MODEL: 'x' })).toBe(false);
  });

  it('recommends f16 builds only when the GPU has shader-f16', () => {
    expect(recommendedWebLlmModels(true).every((m) => m.includes('q4f16'))).toBe(true);
    expect(recommendedWebLlmModels(false).every((m) => m.includes('q4f32'))).toBe(true);
    expect(smallestWebLlmModel(false)).toBe('SmolLM2-360M-Instruct-q4f32_1-MLC');
  });
});

describe('message shaping', () => {
  it('merges system messages into one leading message for WebLLM', () => {
    expect(
      toWebLlmMessages([
        { role: 'system', content: 'a' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'r1' },
        { role: 'system', content: 'b' },
        { role: 'user', content: 'q2' },
      ]),
    ).toEqual([
      { role: 'system', content: 'a\n\nb' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(() => toWebLlmMessages([{ role: 'assistant', content: 'x' }])).toThrow(Vid2ContextError);
  });

  it('splits a chat into initial prompts and the last user turn for the Prompt API', () => {
    expect(
      splitForPromptApi([
        { role: 'system', content: 's' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'q2' },
      ]),
    ).toEqual({
      initialPrompts: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'r1' },
      ],
      input: 'q2',
    });
    expect(() => splitForPromptApi([])).toThrow(/last message must be from the user/);
  });

  it('turns cumulative Prompt API chunks into deltas and passes deltas through', () => {
    expect(newText('', 'Hello')).toBe('Hello');
    expect(newText('Hello', 'Hello world')).toBe(' world');
    expect(newText('Hello', ' world')).toBe(' world');
  });

  it('normalizes availability answers from every Chrome release', () => {
    expect(normalizeAvailability('available')).toBe('available');
    expect(normalizeAvailability('readily')).toBe('available');
    expect(normalizeAvailability('downloadable')).toBe('downloadable');
    expect(normalizeAvailability('downloading')).toBe('downloadable');
    expect(normalizeAvailability('after-download')).toBe('downloadable');
    expect(normalizeAvailability('unavailable')).toBe('unavailable');
    expect(normalizeAvailability('no')).toBe('unavailable');
    expect(normalizeAvailability(undefined)).toBe('unavailable');
  });
});

describe('detection and env flags', () => {
  it('reports nothing in Node, where neither WebGPU nor the Prompt API exist', async () => {
    expect(await detectBrowserAi()).toEqual({ webgpu: false, webllm: false, chromePromptApi: 'unavailable', shaderF16: false });
  });

  it('writes env flags only for what is usable', () => {
    const none = { webgpu: false, webllm: false, chromePromptApi: 'unavailable' as const, shaderF16: false };
    expect(browserAiEnv(none, { allowDownloads: true })).toEqual({});
    expect(browserAiEnv({ ...none, chromePromptApi: 'available' })).toEqual({ CHROME_AI: '1' });
    expect(browserAiEnv({ ...none, chromePromptApi: 'downloadable' })).toEqual({});
    expect(browserAiEnv({ ...none, chromePromptApi: 'downloadable' }, { allowDownloads: true })).toEqual({ CHROME_AI: '1' });
    expect(browserAiEnv({ ...none, webgpu: true, webllm: true })).toEqual({});
    expect(browserAiEnv({ ...none, webgpu: true, webllm: true, shaderF16: true }, { allowDownloads: true })).toEqual({
      WEBLLM_MODEL: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    });
  });

  it('fails with no-provider and a hint when the engines are missing', async () => {
    const ctx = testContext({ runtime: 'browser', env: { WEBLLM_MODEL: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', CHROME_AI: '1' } });
    const req = { messages: [{ role: 'user' as const, content: 'hi' }] };
    for (const rung of provider.rungs(ctx.env).filter((r) => r.isEnabled?.(ctx.env))) {
      const err = await rung.chat(req, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(Vid2ContextError);
      expect(err.code).toBe('no-provider');
      expect(err.hint).toMatch(/another LLM/);
    }
  });
});

describe('packaging', () => {
  it('is browser-only and imports no Node built-ins', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', pkgRoot), 'utf8'));
    expect(pkg.vid2context.runtimes).toEqual(['browser']);
    for (const f of ['index.ts', 'webllm.ts', 'chrome-ai.ts', 'detect.ts', 'progress.ts']) {
      const code = readFileSync(new URL(`src/${f}`, pkgRoot), 'utf8');
      expect(code).not.toMatch(/from ['"]node:/);
      expect(code).not.toMatch(/process\.env/);
    }
  });

  it('is in the browser registry only', () => {
    const gen = (r: string) => readFileSync(new URL(`../../../packages/registry/src/generated/${r}.ts`, import.meta.url), 'utf8');
    expect(gen('browser')).toContain('@vid2context/provider-llm-browser');
    expect(gen('node')).not.toContain('@vid2context/provider-llm-browser');
    expect(gen('workers')).not.toContain('@vid2context/provider-llm-browser');
    expect(gen('node')).toContain('@vid2context/provider-stt-transformers');
    expect(gen('browser')).toContain('@vid2context/provider-stt-transformers');
    expect(gen('workers')).not.toContain('@vid2context/provider-stt-transformers');
  });
});
