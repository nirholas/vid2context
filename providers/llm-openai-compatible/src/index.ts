/**
 * Chat-completion rungs for every OpenAI-compatible API, free first.
 *
 *   local    Ollama (OLLAMA_MODEL), LM Studio (LMSTUDIO_MODEL), any server (LOCAL_LLM_BASE_URL + LOCAL_LLM_MODEL)
 *   free     Groq, Cerebras, Mistral, GitHub Models, Gemini AI Studio (your own free key)
 *   keyless  OVH AI Endpoints (Llama 3.3 70B, gpt-oss-120b) and Pollinations (no account)
 *   paid     OpenAI (OPENAI_API_KEY)
 *
 * Groq and Cerebras meter quota per model, so each model is its own rung.
 * <PROVIDER>_MODEL replaces a lane's model list (comma-separated, in order).
 * <PROVIDER>_FALLBACK_KEYS adds one rung per extra key.
 */
import {
  defineProvider,
  type Env,
  keyPool,
  type LlmProvider,
  type LlmRung,
  pooledService,
  type StreamingLlmRung,
  streamOpenAiChat,
  type Tier,
} from '@vid2context/core';
import { buildBody, type ChatEndpoint, chatWith } from './client.ts';

export { answerText, buildBody, chatWith } from './client.ts';

interface ModelDef {
  id: string;
  quality: number;
  contextTokens?: number;
  /** Absolute priority within the tier; default lane.priority + position. */
  priority?: number;
}

interface Lane {
  service: string;
  tier: Tier;
  priority: number;
  /** Full chat completions URL, from env when it can be overridden. */
  url: (env: Env) => string;
  /** Env var holding the key. Absent for keyless lanes; optional (keyVarOptional) for local servers. */
  keyVar?: string;
  keyVarOptional?: boolean;
  modelVar: string;
  models: ModelDef[];
  /** Local lanes have no default model: they are enabled by setting modelVar. */
  needsModelVar?: boolean;
  /** Extra env vars that must be set (besides the key). */
  alsoRequires?: string[];
  json: boolean;
  jsonSchema?: boolean;
}

const OVH = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';

export const LANES: Lane[] = [
  // ---- local: your machine, free and private
  {
    service: 'ollama',
    tier: 'local',
    priority: 10,
    url: (env) => `${(env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '')}/chat/completions`,
    modelVar: 'OLLAMA_MODEL',
    models: [],
    needsModelVar: true,
    json: true,
  },
  {
    service: 'lmstudio',
    tier: 'local',
    priority: 20,
    url: (env) => `${(env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1').replace(/\/+$/, '')}/chat/completions`,
    modelVar: 'LMSTUDIO_MODEL',
    models: [],
    needsModelVar: true,
    json: true,
    jsonSchema: true,
  },
  {
    service: 'local',
    tier: 'local',
    priority: 30,
    url: (env) => `${(env.LOCAL_LLM_BASE_URL || '').replace(/\/+$/, '')}/chat/completions`,
    keyVar: 'LOCAL_LLM_API_KEY',
    keyVarOptional: true,
    modelVar: 'LOCAL_LLM_MODEL',
    models: [],
    needsModelVar: true,
    alsoRequires: ['LOCAL_LLM_BASE_URL'],
    json: false,
  },
  // ---- free: hosted free tiers with your own key
  {
    service: 'groq',
    tier: 'free',
    priority: 10,
    url: () => 'https://api.groq.com/openai/v1/chat/completions',
    keyVar: 'GROQ_API_KEY',
    modelVar: 'GROQ_MODEL',
    models: [
      { id: 'qwen/qwen3.8-27b', quality: 4, contextTokens: 131_072 },
      { id: 'openai/gpt-oss-120b', quality: 4, contextTokens: 131_072 },
      // A capability step-down, so it runs after the other free lanes.
      { id: 'openai/gpt-oss-20b', quality: 3, contextTokens: 131_072, priority: 90 },
    ],
    json: true,
  },
  {
    service: 'cerebras',
    tier: 'free',
    priority: 20,
    url: () => 'https://api.cerebras.ai/v1/chat/completions',
    keyVar: 'CEREBRAS_API_KEY',
    modelVar: 'CEREBRAS_MODEL',
    models: [
      { id: 'gpt-oss-120b', quality: 4, contextTokens: 65_536 },
      { id: 'llama-3.3-70b', quality: 3, contextTokens: 65_536 },
    ],
    json: true,
    jsonSchema: true,
  },
  {
    service: 'mistral',
    tier: 'free',
    priority: 50,
    url: () => 'https://api.mistral.ai/v1/chat/completions',
    keyVar: 'MISTRAL_API_KEY',
    modelVar: 'MISTRAL_MODEL',
    models: [{ id: 'mistral-small-latest', quality: 3, contextTokens: 131_072 }],
    json: true,
  },
  {
    service: 'github',
    tier: 'free',
    priority: 60,
    url: () => 'https://models.github.ai/inference/chat/completions',
    keyVar: 'GITHUB_TOKEN',
    modelVar: 'GITHUB_MODEL',
    models: [{ id: 'meta/Llama-3.3-70B-Instruct', quality: 3, contextTokens: 8_000 }],
    json: false,
  },
  {
    service: 'gemini',
    tier: 'free',
    priority: 70,
    url: () => 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyVar: 'GEMINI_API_KEY',
    modelVar: 'GEMINI_MODEL',
    models: [{ id: 'gemini-2.5-flash-lite', quality: 4, contextTokens: 1_048_576 }],
    json: true,
    jsonSchema: true,
  },
  // ---- keyless: hosted, no key; about 2 requests/minute per model per IP on OVH
  {
    service: 'ovh',
    tier: 'keyless',
    priority: 10,
    url: () => OVH,
    modelVar: 'OVH_MODEL',
    models: [
      { id: 'Meta-Llama-3_3-70B-Instruct', quality: 3, contextTokens: 131_072 },
      { id: 'gpt-oss-120b', quality: 4, contextTokens: 131_072 },
    ],
    json: true,
  },
  {
    service: 'pollinations',
    tier: 'keyless',
    priority: 20,
    url: () => 'https://text.pollinations.ai/openai',
    modelVar: 'POLLINATIONS_MODEL',
    models: [{ id: 'openai-fast', quality: 3, contextTokens: 131_072 }],
    json: true,
  },
  // ---- paid: last backstop, only when the key is set
  {
    service: 'openai',
    tier: 'paid',
    priority: 10,
    url: (env) => `${(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`,
    keyVar: 'OPENAI_API_KEY',
    modelVar: 'OPENAI_MODEL',
    models: [{ id: 'gpt-5.4-nano', quality: 4, contextTokens: 400_000 }],
    json: true,
    jsonSchema: true,
  },
];

function modelsFor(lane: Lane, env: Env): ModelDef[] {
  const override = (env[lane.modelVar] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (override.length === 0) return lane.models;
  return override.map((id) => lane.models.find((m) => m.id === id) ?? { id, quality: 3 });
}

function makeRung(
  lane: Lane,
  env: Env,
  model: ModelDef,
  i: number,
  opts: { service: string; key?: string; requires: string[]; enabled: boolean },
): LlmRung {
  const ep: ChatEndpoint = {
    url: lane.url(env),
    model: model.id,
    key: opts.key,
    label: opts.service,
    jsonSchema: lane.jsonSchema,
  };
  const capabilities = [...(lane.json ? ['json'] : []), ...(lane.jsonSchema ? ['json-schema'] : [])];
  const rung: StreamingLlmRung = {
    id: model.id ? `llm/${opts.service}/${model.id}` : `llm/${opts.service}`,
    provider: 'llm-openai-compatible',
    service: opts.service,
    model: model.id,
    tier: lane.tier,
    priority: model.priority ?? lane.priority + i,
    quality: model.quality,
    capabilities,
    requires: opts.requires,
    isEnabled: () => opts.enabled,
    contextTokens: model.contextTokens,
    chat: (req, ctx) => chatWith(ep, req, ctx),
    // Same endpoint, key and request body as chat(), plus the streaming fields.
    stream: (req, ctx) =>
      streamOpenAiChat(
        {
          url: ep.url,
          model: ep.model,
          key: ep.key,
          label: ep.label,
          body: (r) => buildBody(ep, r),
          idleTimeoutMs: ep.timeoutMs,
        },
        req,
        ctx,
      ),
  };
  return rung;
}

function laneRungs(lane: Lane, env: Env): LlmRung[] {
  const models = modelsFor(lane, env);
  const extra = lane.alsoRequires ?? [];
  const extraSet = extra.every((v) => Boolean(env[v]));

  if (lane.needsModelVar) {
    const requires = [lane.modelVar, ...extra];
    if (models.length === 0) {
      return [makeRung(lane, env, { id: '', quality: 3 }, 0, { service: lane.service, requires, enabled: false })];
    }
    const key = lane.keyVar ? env[lane.keyVar] || undefined : undefined;
    return models.map((m, i) => makeRung(lane, env, m, i, { service: lane.service, key, requires, enabled: extraSet }));
  }

  if (!lane.keyVar) {
    return models.map((m, i) => makeRung(lane, env, m, i, { service: lane.service, requires: extra, enabled: extraSet }));
  }

  const keys = keyPool(env, lane.keyVar);
  if (keys.length === 0) {
    return models.map((m, i) =>
      makeRung(lane, env, m, i, { service: lane.service, requires: [lane.keyVar as string, ...extra], enabled: false }),
    );
  }
  return keys.flatMap((k) =>
    models.map((m, i) =>
      makeRung(lane, env, m, i, {
        service: pooledService(lane.service, k.index),
        key: k.key,
        requires: [k.envVar, ...extra],
        enabled: extraSet,
      }),
    ),
  );
}

export function llmRungs(env: Env): LlmRung[] {
  return LANES.flatMap((lane) => laneRungs(lane, env));
}

const provider: LlmProvider = defineProvider({
  id: 'llm-openai-compatible',
  kind: 'llm',
  name: 'OpenAI-compatible chat completions',
  runtimes: ['node', 'workers', 'browser'],
  rungs: llmRungs,
});

export default provider;
