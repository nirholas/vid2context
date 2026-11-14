/**
 * Local chat rungs that run inside the browser: WebLLM on WebGPU and Chrome's
 * built-in Prompt API. Browser runtime only. Nothing is sent anywhere: the
 * models run on the user's device after a one-time download.
 */
import { defineProvider, type Env, type LlmRung } from '@vid2context/core';
import { chromeAiRung } from './chrome-ai.ts';
import { webLlmRungs } from './webllm.ts';

export * from './chrome-ai.ts';
export * from './detect.ts';
export * from './progress.ts';
export * from './webllm.ts';

const llmBrowser = defineProvider({
  id: 'llm-browser',
  kind: 'llm',
  name: 'In-browser LLMs (WebLLM, Chrome built-in AI)',
  runtimes: ['browser'],
  rungs(env: Env): LlmRung[] {
    return [...webLlmRungs(env), chromeAiRung()];
  },
});

export default llmBrowser;
