/**
 * Feature detection for in-browser AI. The rungs themselves stay env-only:
 * the web app runs detectBrowserAi() once, then writes env flags
 * (WEBLLM_MODEL, CHROME_AI=1) into the browser Env so isEnabled() can decide
 * synchronously without touching the GPU or the Prompt API.
 */
import type { Env } from '@vid2context/core';
import { recommendedWebLlmModels } from './webllm.ts';

export type PromptApiAvailability = 'available' | 'downloadable' | 'unavailable';

export interface BrowserAiSupport {
  /** navigator.gpu exists and handed out an adapter. */
  webgpu: boolean;
  /** WebLLM can run (it needs WebGPU). */
  webllm: boolean;
  /** Chrome's built-in Prompt API: ready now, ready after a model download, or not offered. */
  chromePromptApi: PromptApiAvailability;
  /** The adapter supports 16-bit float shaders, so the smaller q4f16 WebLLM builds work. */
  shaderF16: boolean;
}

interface GpuAdapterLike {
  features?: { has(name: string): boolean };
}
interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

/** The Prompt API global as Chrome ships it (Chrome 138 in extensions, 148 on the web). */
export interface LanguageModelStatic {
  availability(options?: Record<string, unknown>): Promise<string>;
  create(options?: Record<string, unknown>): Promise<LanguageModelSession>;
  params?(): Promise<{ defaultTopK: number; maxTopK: number; defaultTemperature: number; maxTemperature: number } | null>;
}
export interface LanguageModelSession {
  prompt(input: string, options?: Record<string, unknown>): Promise<string>;
  promptStreaming(input: string, options?: Record<string, unknown>): ReadableStream<string>;
  destroy(): void;
  /** Current name of the context window size. */
  contextWindow?: number;
  contextUsage?: number;
  /** Names used by Chrome releases before contextWindow. */
  inputQuota?: number;
  inputUsage?: number;
}

export function languageModelGlobal(): LanguageModelStatic | undefined {
  return (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;
}

/** Text in and out, in English, the language every Prompt API release supports. */
export const PROMPT_API_IO = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

/** Map the Prompt API's availability() answer onto three states. */
export function normalizeAvailability(value: string | undefined): PromptApiAvailability {
  if (value === 'available' || value === 'readily') return 'available';
  if (value === 'downloadable' || value === 'downloading' || value === 'after-download') return 'downloadable';
  return 'unavailable';
}

export async function detectBrowserAi(): Promise<BrowserAiSupport> {
  let webgpu = false;
  let shaderF16 = false;
  const gpu = (globalThis.navigator as (Navigator & { gpu?: GpuLike }) | undefined)?.gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      webgpu = adapter !== null;
      shaderF16 = Boolean(adapter?.features?.has('shader-f16'));
    } catch {
      webgpu = false;
    }
  }
  let chromePromptApi: PromptApiAvailability = 'unavailable';
  const lm = languageModelGlobal();
  if (lm) {
    try {
      chromePromptApi = normalizeAvailability(await lm.availability(PROMPT_API_IO));
    } catch {
      chromePromptApi = 'unavailable';
    }
  }
  return { webgpu, webllm: webgpu, chromePromptApi, shaderF16 };
}

/**
 * Env flags for a detection result, for the web app to merge into its browser
 * Env. Model downloads are large (the Prompt API model needs about 22 GB of
 * free disk; WebLLM models are 0.4 to 4 GB), so downloadable engines are only
 * switched on when the user agreed to downloads.
 */
export function browserAiEnv(support: BrowserAiSupport, opts: { allowDownloads?: boolean } = {}): Env {
  const env: Env = {};
  if (support.chromePromptApi === 'available' || (support.chromePromptApi === 'downloadable' && opts.allowDownloads)) {
    env.CHROME_AI = '1';
  }
  if (support.webllm && opts.allowDownloads) {
    env.WEBLLM_MODEL = recommendedWebLlmModels(support.shaderF16)[0];
  }
  return env;
}
