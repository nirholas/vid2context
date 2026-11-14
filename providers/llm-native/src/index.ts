/**
 * Native LLM rungs: the Anthropic Messages API, Gemini's generateContent API,
 * and both model families on Vertex AI. Each rung streams natively, supports
 * JSON output, and reports cache usage so repeated questions about the same
 * transcript are visibly cheaper.
 *
 *   free   gemini-native     GEMINI_API_KEY (+ GEMINI_FALLBACK_KEYS), GEMINI_NATIVE_MODEL
 *   paid   anthropic         ANTHROPIC_API_KEY (+ ANTHROPIC_FALLBACK_KEYS), ANTHROPIC_MODEL, ANTHROPIC_BASE_URL
 *   paid   vertex-gemini     GOOGLE_CLOUD_PROJECT + token source, VERTEX_GEMINI_MODEL, GOOGLE_CLOUD_LOCATION
 *   paid   vertex-anthropic  GOOGLE_CLOUD_PROJECT + token source, VERTEX_ANTHROPIC_MODEL, VERTEX_ANTHROPIC_LOCATION
 *
 * The OpenAI-compatible Gemini rung (`llm/gemini/...`) lives in
 * llm-openai-compatible; these use the service name `gemini-native` so ids
 * never collide. Both draw on the same AI Studio quota.
 */
import {
  defineProvider,
  type Env,
  keyPool,
  type LlmProvider,
  pooledService,
  type StreamingLlmRung,
  type Tier,
} from '@vid2context/core';
import { ANTHROPIC_VERSION, type AnthropicTarget, anthropicChat, anthropicStream } from './anthropic.ts';
import { type ModelDef, modelsFromEnv, trimBase } from './common.ts';
import { type GeminiTarget, geminiChat, geminiStream } from './gemini.ts';
import { VERTEX_AUTH_HINT, vertexEnabled, vertexHeaders, vertexModelUrl, vertexRequires } from './vertex.ts';

export { ANTHROPIC_VERSION, anthropicSchema, buildAnthropicBody, buildMessages, minCacheTokens } from './anthropic.ts';
export type { NativeChatResult, NativeUsage } from './common.ts';
export { buildGeminiBody, geminiSchema } from './gemini.ts';

export const PROVIDER_ID = 'llm-native';

/** Claude defaults: the cheapest current Haiku first, the current Sonnet as the higher-quality rung. */
export const ANTHROPIC_MODELS: ModelDef[] = [
  { id: 'claude-haiku-5-5', quality: 4, contextTokens: 1_000_000 },
  { id: 'claude-sonnet-5-5', quality: 5, contextTokens: 1_000_000 },
];

/** Free-tier Gemini models on AI Studio (pricing page, 2026-11-14): the current Flash, then the current Flash-Lite. */
export const GEMINI_MODELS: ModelDef[] = [
  { id: 'gemini-3.8-flash', quality: 4, contextTokens: 1_048_576 },
  { id: 'gemini-3.5-flash-lite', quality: 3, contextTokens: 1_048_576 },
];

export const VERTEX_GEMINI_MODELS: ModelDef[] = [{ id: 'gemini-3.8-flash', quality: 4, contextTokens: 1_048_576 }];
export const VERTEX_ANTHROPIC_MODELS: ModelDef[] = [{ id: 'claude-haiku-5-5', quality: 4, contextTokens: 1_000_000 }];

const ANTHROPIC_AUTH_HINT = 'Anthropic rejected the key. Check ANTHROPIC_API_KEY (Claude Console, API keys).';
const GEMINI_AUTH_HINT = 'Google rejected the key. Check GEMINI_API_KEY (https://aistudio.google.com/apikey).';

interface RungSpec {
  service: string;
  tier: Tier;
  priority: number;
  model: ModelDef;
  requires: string[];
  enabled: boolean;
  chat: StreamingLlmRung['chat'];
  stream: StreamingLlmRung['stream'];
}

function rung(s: RungSpec): StreamingLlmRung {
  return {
    id: `llm/${s.service}/${s.model.id}`,
    provider: PROVIDER_ID,
    service: s.service,
    model: s.model.id,
    tier: s.tier,
    priority: s.priority,
    quality: s.model.quality,
    capabilities: ['json', 'json-schema', 'stream'],
    requires: s.requires,
    isEnabled: () => s.enabled,
    contextTokens: s.model.contextTokens,
    chat: s.chat,
    stream: s.stream,
  };
}

/** One rung per key and model; disabled placeholders (no key) so health output shows what a key unlocks. */
function pooled(
  env: Env,
  keyVar: string,
  models: ModelDef[],
  make: (model: ModelDef, i: number, key: { key?: string; service: string; envVar: string }) => StreamingLlmRung,
  service: string,
): StreamingLlmRung[] {
  const keys = keyPool(env, keyVar);
  if (keys.length === 0) return models.map((m, i) => make(m, i, { service, envVar: keyVar }));
  return keys.flatMap((k) =>
    models.map((m, i) => make(m, i, { key: k.key, service: pooledService(service, k.index), envVar: k.envVar })),
  );
}

function anthropicRungs(env: Env): StreamingLlmRung[] {
  const base = trimBase(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  return pooled(
    env,
    'ANTHROPIC_API_KEY',
    modelsFromEnv(env, 'ANTHROPIC_MODEL', ANTHROPIC_MODELS),
    (model, i, k) => {
      const target: AnthropicTarget = {
        label: k.service,
        model: model.id,
        flavor: 'api',
        url: `${base}/v1/messages`,
        streamUrl: `${base}/v1/messages`,
        headers: async () => ({ 'x-api-key': k.key ?? '', 'anthropic-version': ANTHROPIC_VERSION }),
        authHint: ANTHROPIC_AUTH_HINT,
      };
      return rung({
        service: k.service,
        tier: 'paid',
        priority: 20 + i,
        model,
        requires: [k.envVar],
        enabled: Boolean(k.key),
        chat: (req, ctx) => anthropicChat(target, req, ctx),
        stream: (req, ctx) => anthropicStream(target, req, ctx),
      });
    },
    'anthropic',
  );
}

function geminiRungs(env: Env): StreamingLlmRung[] {
  const base = 'https://generativelanguage.googleapis.com/v1beta/models';
  return pooled(
    env,
    'GEMINI_API_KEY',
    modelsFromEnv(env, 'GEMINI_NATIVE_MODEL', GEMINI_MODELS),
    (model, i, k) => {
      const target: GeminiTarget = {
        label: k.service,
        model: model.id,
        url: `${base}/${model.id}:generateContent`,
        streamUrl: `${base}/${model.id}:streamGenerateContent?alt=sse`,
        headers: async () => ({ 'x-goog-api-key': k.key ?? '' }),
        authHint: GEMINI_AUTH_HINT,
      };
      return rung({
        service: k.service,
        tier: 'free',
        // Right after the OpenAI-compatible Gemini rung (70), which shares the same AI Studio quota.
        priority: 72 + i,
        model,
        requires: [k.envVar],
        enabled: Boolean(k.key),
        chat: (req, ctx) => geminiChat(target, req, ctx),
        stream: (req, ctx) => geminiStream(target, req, ctx),
      });
    },
    'gemini-native',
  );
}

function vertexGeminiRungs(env: Env): StreamingLlmRung[] {
  const location = env.GOOGLE_CLOUD_LOCATION || 'us-central1';
  const enabled = vertexEnabled(env);
  return modelsFromEnv(env, 'VERTEX_GEMINI_MODEL', VERTEX_GEMINI_MODELS).map((model, i) => {
    const target: GeminiTarget = {
      label: 'vertex-gemini',
      model: model.id,
      url: vertexModelUrl(env, location, 'google', model.id, 'generateContent'),
      streamUrl: `${vertexModelUrl(env, location, 'google', model.id, 'streamGenerateContent')}?alt=sse`,
      headers: vertexHeaders,
      authHint: VERTEX_AUTH_HINT,
    };
    return rung({
      service: 'vertex-gemini',
      tier: 'paid',
      priority: 30 + i,
      model,
      requires: vertexRequires(env),
      enabled,
      chat: (req, ctx) => geminiChat(target, req, ctx),
      stream: (req, ctx) => geminiStream(target, req, ctx),
    });
  });
}

function vertexAnthropicRungs(env: Env): StreamingLlmRung[] {
  const location = env.VERTEX_ANTHROPIC_LOCATION || 'global';
  const enabled = vertexEnabled(env);
  return modelsFromEnv(env, 'VERTEX_ANTHROPIC_MODEL', VERTEX_ANTHROPIC_MODELS).map((model, i) => {
    const target: AnthropicTarget = {
      label: 'vertex-anthropic',
      model: model.id,
      flavor: 'vertex',
      url: vertexModelUrl(env, location, 'anthropic', model.id, 'rawPredict'),
      streamUrl: vertexModelUrl(env, location, 'anthropic', model.id, 'streamRawPredict'),
      headers: vertexHeaders,
      authHint: VERTEX_AUTH_HINT,
    };
    return rung({
      service: 'vertex-anthropic',
      tier: 'paid',
      priority: 40 + i,
      model,
      requires: vertexRequires(env),
      enabled,
      chat: (req, ctx) => anthropicChat(target, req, ctx),
      stream: (req, ctx) => anthropicStream(target, req, ctx),
    });
  });
}

export function nativeRungs(env: Env): StreamingLlmRung[] {
  return [...geminiRungs(env), ...anthropicRungs(env), ...vertexGeminiRungs(env), ...vertexAnthropicRungs(env)];
}

const provider: LlmProvider = defineProvider({
  id: PROVIDER_ID,
  kind: 'llm',
  name: 'Native Anthropic and Gemini (with Vertex AI)',
  runtimes: ['node', 'workers', 'browser'],
  rungs: nativeRungs,
});

export default provider;
