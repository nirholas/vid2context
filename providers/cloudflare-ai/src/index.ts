/**
 * Cloudflare Workers AI rungs (tier free: 10,000 neurons per day on every
 * account, reset at 00:00 UTC; checked 2026-11-14).
 *
 *   binding  Inside a Worker, through the AI binding. Enabled by CLOUDFLARE_AI_BINDING
 *            (the binding name, usually AI); the binding is read from ctx.bindings at call time.
 *            stt/cloudflare-binding/<model>, llm/cloudflare-binding/<model>, embed/cloudflare-binding/<model>
 *   rest     Anywhere, with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
 *            stt/cloudflare/<model>, embed/cloudflare/<model>
 *            (the REST LLM rung lives in the free LLM catalog through Cloudflare's OpenAI-compatible endpoint)
 *
 * Model lists: CLOUDFLARE_STT_MODEL, CLOUDFLARE_EMBED_MODEL, CLOUDFLARE_BINDING_MODEL (comma-separated, in order).
 */
import {
  type ChatStreamEvent,
  defineProvider,
  type EmbedProvider,
  type EmbedRung,
  type Env,
  type LlmProvider,
  type LlmRung,
  type StreamingLlmRung,
  type SttProvider,
  type SttRung,
} from '@vid2context/core';
import { EMBED_DIMENSIONS, embedTexts } from './embed.ts';
import { chat, streamChat } from './llm.ts';
import { LEGACY_WHISPER, transcribe } from './stt.ts';
import { REST_BASE_URL, type Transport } from './transport.ts';

export { EMBED_DIMENSIONS, embedTexts } from './embed.ts';
export { answerText, buildChatInput, chat, parseSse, streamChat } from './llm.ts';
export { parseLegacy, parseTurbo, segmentsFromWords, transcribe } from './stt.ts';
export {
  type AiBinding,
  errorFromBinding,
  getAiBinding,
  mapCloudflareCode,
  REST_BASE_URL,
  runModel,
  type Transport,
} from './transport.ts';

export const BINDING_SERVICE = 'cloudflare-binding';
export const REST_SERVICE = 'cloudflare';

export const DEFAULT_STT_MODELS = ['@cf/openai/whisper-large-v3-turbo', '@cf/openai/whisper'];
export const DEFAULT_EMBED_MODEL = '@cf/baai/bge-m3';
export const DEFAULT_BINDING_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/openai/gpt-oss-120b',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
];

interface LlmSpec {
  quality: number;
  contextTokens?: number;
  /** response_format json_object listed in the model schema and verified with a recorded response. */
  json: boolean;
}

/** Context windows from the Workers AI model catalog; JSON mode verified by recordings (2026-11-14). */
const LLM_SPECS: Record<string, LlmSpec> = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { quality: 4, contextTokens: 24_000, json: true },
  '@cf/openai/gpt-oss-120b': { quality: 4, contextTokens: 128_000, json: true },
  '@cf/meta/llama-4-scout-17b-16e-instruct': { quality: 3, contextTokens: 131_000, json: true },
  '@cf/mistralai/mistral-small-3.1-24b-instruct': { quality: 3, contextTokens: 128_000, json: false },
};

function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? [...new Set(items)] : fallback;
}

function bindingTransport(env: Env): Transport {
  return { kind: 'binding', binding: env.CLOUDFLARE_AI_BINDING || 'AI' };
}

function restTransport(env: Env): Transport {
  return {
    kind: 'rest',
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? '',
    token: env.CLOUDFLARE_API_TOKEN ?? '',
    baseUrl: REST_BASE_URL,
  };
}

const REST_REQUIRES = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
const restEnabled = (env: Env) => Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
const bindingEnabled = (env: Env) => Boolean(env.CLOUDFLARE_AI_BINDING);

export function sttRungs(env: Env): SttRung[] {
  const models = list(env.CLOUDFLARE_STT_MODEL, DEFAULT_STT_MODELS);
  const make = (service: string, t: Transport, basePriority: number, requires: string[], enabled: boolean) =>
    models.map((model, i): SttRung => {
      const legacy = LEGACY_WHISPER.has(model);
      return {
        id: `stt/${service}/${model}`,
        provider: 'cloudflare-ai-stt',
        service,
        model,
        tier: 'free',
        priority: basePriority + i * 10,
        quality: legacy ? 2 : 4,
        capabilities: legacy ? ['segments', 'words'] : ['segments', 'words', 'language-detect', 'prompt'],
        requires,
        isEnabled: () => enabled,
        transcribe: (audio, opts, ctx) => transcribe(t, model, audio, opts, ctx, `${service} ${model}`),
      };
    });
  return [
    ...make(BINDING_SERVICE, bindingTransport(env), 20, ['CLOUDFLARE_AI_BINDING'], bindingEnabled(env)),
    ...make(REST_SERVICE, restTransport(env), 40, REST_REQUIRES, restEnabled(env)),
  ];
}

export function llmRungs(env: Env): LlmRung[] {
  const t = bindingTransport(env);
  const enabled = bindingEnabled(env);
  return list(env.CLOUDFLARE_BINDING_MODEL, DEFAULT_BINDING_MODELS).map((model, i) => {
    const spec = LLM_SPECS[model] ?? { quality: 3, json: false };
    const label = `${BINDING_SERVICE} ${model}`;
    const rung: StreamingLlmRung = {
      id: `llm/${BINDING_SERVICE}/${model}`,
      provider: 'cloudflare-ai-llm',
      service: BINDING_SERVICE,
      model,
      tier: 'free',
      priority: 30 + i * 10,
      quality: spec.quality,
      capabilities: spec.json ? ['json', 'stream'] : ['stream'],
      requires: ['CLOUDFLARE_AI_BINDING'],
      isEnabled: () => enabled,
      contextTokens: spec.contextTokens,
      chat: (req, ctx) => chat(t, model, spec.json, req, ctx, label),
      stream: (req, ctx): AsyncIterable<ChatStreamEvent> => streamChat(t, model, spec.json, req, ctx, label),
    };
    return rung;
  });
}

export function embedRungs(env: Env): EmbedRung[] {
  const model = env.CLOUDFLARE_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
  const known = EMBED_DIMENSIONS[model];
  const override = Number(env.CLOUDFLARE_EMBED_DIMENSIONS);
  const dimensions = known ?? (Number.isInteger(override) && override > 0 ? override : 0);
  // An unknown model needs CLOUDFLARE_EMBED_DIMENSIONS so vectors are never stored with a wrong size.
  const extra = known ? [] : ['CLOUDFLARE_EMBED_DIMENSIONS'];
  const make = (service: string, t: Transport, priority: number, requires: string[], enabled: boolean): EmbedRung => ({
    id: `embed/${service}/${model}`,
    provider: 'cloudflare-ai-embed',
    service,
    model,
    tier: 'free',
    priority,
    quality: 4,
    capabilities: [],
    requires: [...requires, ...extra],
    isEnabled: () => enabled && dimensions > 0,
    dimensions,
    embed: (texts, ctx) => embedTexts(t, model, texts, ctx, `${service} ${model}`),
  });
  return [
    make(BINDING_SERVICE, bindingTransport(env), 20, ['CLOUDFLARE_AI_BINDING'], bindingEnabled(env)),
    make(REST_SERVICE, restTransport(env), 40, REST_REQUIRES, restEnabled(env)),
  ];
}

const runtimes: ('node' | 'workers' | 'browser')[] = ['node', 'workers', 'browser'];

export const sttProvider: SttProvider = defineProvider({
  id: 'cloudflare-ai-stt',
  kind: 'stt',
  name: 'Cloudflare Workers AI speech-to-text',
  runtimes,
  rungs: sttRungs,
});

export const llmProvider: LlmProvider = defineProvider({
  id: 'cloudflare-ai-llm',
  kind: 'llm',
  name: 'Cloudflare Workers AI chat (binding)',
  runtimes,
  rungs: llmRungs,
});

export const embedProvider: EmbedProvider = defineProvider({
  id: 'cloudflare-ai-embed',
  kind: 'embed',
  name: 'Cloudflare Workers AI embeddings',
  runtimes,
  rungs: embedRungs,
});

export default [sttProvider, llmProvider, embedProvider];
