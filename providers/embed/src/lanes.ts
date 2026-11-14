/**
 * Embedding rungs over OpenAI-compatible HTTP, free first.
 *
 *   local    Ollama (OLLAMA_EMBED_MODEL), LM Studio (LMSTUDIO_EMBED_MODEL), any server (LOCAL_EMBED_BASE_URL + LOCAL_EMBED_MODEL)
 *   free     Gemini, Jina, Cloudflare Workers AI, Mistral (your own free key)
 *   keyless  OVH AI Endpoints bge-m3 and Qwen3-Embedding-8B (no account)
 *   paid     OpenAI text-embedding-3-small (OPENAI_API_KEY)
 *
 * <PROVIDER>_EMBED_MODEL replaces a lane's model. <PROVIDER>_FALLBACK_KEYS adds
 * one rung per extra key; pooled keys of the same service and model produce
 * identical vectors, so they can stand in for each other on one index.
 */
import { type Env, keyPool, pooledService, type Tier } from '@vid2context/core';
import { type EmbedEndpoint, postEmbeddings } from './client.ts';
import { type EmbedMode, makeEmbedRung, type RetrievalEmbedRung } from './rung.ts';

export const PROVIDER_ID = 'embed';

export interface EmbedModelInfo {
  /** Output size; 0 when unknown (measured on the first call). */
  dimensions: number;
  maxInputTokens: number;
  /** Retrieval quality, 1 (rough) to 5 (best). */
  quality: number;
}

/**
 * Facts about models the lanes serve by default or users commonly pick.
 * Dimensions marked "measured" were read from real responses on 2026-11-14;
 * the rest come from the model cards and are checked on every call.
 */
const KNOWN: { match: RegExp; info: EmbedModelInfo }[] = [
  // measured: OVH and Cloudflare return 1024 values
  { match: /bge-m3/i, info: { dimensions: 1024, maxInputTokens: 8192, quality: 4 } },
  // measured: OVH returns 4096 values for the 8B model
  { match: /qwen3-embedding-8b/i, info: { dimensions: 4096, maxInputTokens: 8192, quality: 5 } },
  { match: /qwen3-embedding.*4b/i, info: { dimensions: 2560, maxInputTokens: 8192, quality: 4 } },
  { match: /qwen3-embedding.*0\.6b|qwen3-embedding$/i, info: { dimensions: 1024, maxInputTokens: 8192, quality: 4 } },
  { match: /gemini-embedding-2/i, info: { dimensions: 3072, maxInputTokens: 8192, quality: 5 } },
  { match: /gemini-embedding-001/i, info: { dimensions: 3072, maxInputTokens: 2048, quality: 4 } },
  { match: /jina-embeddings-v3/i, info: { dimensions: 1024, maxInputTokens: 8192, quality: 4 } },
  { match: /mistral-embed/i, info: { dimensions: 1024, maxInputTokens: 8192, quality: 3 } },
  { match: /text-embedding-3-small/i, info: { dimensions: 1536, maxInputTokens: 8191, quality: 4 } },
  { match: /text-embedding-3-large/i, info: { dimensions: 3072, maxInputTokens: 8191, quality: 4 } },
  // Ollama runs embeddings with a 2048-token context unless the model sets more.
  { match: /nomic-embed-text/i, info: { dimensions: 768, maxInputTokens: 2048, quality: 3 } },
  { match: /embeddinggemma/i, info: { dimensions: 768, maxInputTokens: 2048, quality: 3 } },
  { match: /mxbai-embed-large/i, info: { dimensions: 1024, maxInputTokens: 512, quality: 3 } },
  { match: /snowflake-arctic-embed2/i, info: { dimensions: 1024, maxInputTokens: 8192, quality: 4 } },
  { match: /snowflake-arctic-embed/i, info: { dimensions: 1024, maxInputTokens: 512, quality: 3 } },
  { match: /multilingual-e5-small|e5-small/i, info: { dimensions: 384, maxInputTokens: 512, quality: 3 } },
  { match: /e5-base/i, info: { dimensions: 768, maxInputTokens: 512, quality: 3 } },
  { match: /e5-large/i, info: { dimensions: 1024, maxInputTokens: 512, quality: 3 } },
  { match: /all-minilm/i, info: { dimensions: 384, maxInputTokens: 256, quality: 2 } },
  { match: /bge-small/i, info: { dimensions: 384, maxInputTokens: 512, quality: 3 } },
  { match: /bge-base/i, info: { dimensions: 768, maxInputTokens: 512, quality: 3 } },
  { match: /bge-large/i, info: { dimensions: 1024, maxInputTokens: 512, quality: 3 } },
];

/** What we know about a model id; unknown models get a conservative 512-token window and measured dimensions. */
export function modelInfo(model: string): EmbedModelInfo {
  return KNOWN.find((k) => k.match.test(model))?.info ?? { dimensions: 0, maxInputTokens: 512, quality: 3 };
}

interface Lane {
  service: string;
  tier: Tier;
  priority: number;
  /** Full embeddings URL. */
  url: (env: Env) => string;
  /** Env var holding the key. Absent for keyless lanes. */
  keyVar?: string;
  /** The key is optional (local servers). */
  /** Extra keys become extra rungs. False when a key is tied to other config (a Cloudflare token to its account). */
  pooled?: boolean;
  modelVar: string;
  /** Default models in order. Empty for local lanes, which are enabled by setting modelVar. */
  models: string[];
  /** Extra env vars that must be set. */
  alsoRequires?: string[];
  maxBatch: number;
  maxBatchTokens?: number;
  /** Extra request fields per mode (Jina selects its retrieval adapter with `task`). */
  modeBody?: (mode: EmbedMode) => Record<string, unknown>;
  /** Do not apply text prefixes (the lane uses modeBody instead). */
  noPrefixes?: boolean;
}

const OVH = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings';

const base = (v: string | undefined, fallback: string) => (v || fallback).replace(/\/+$/, '');

export const LANES: Lane[] = [
  // ---- local: your machine, free and private
  {
    service: 'ollama',
    tier: 'local',
    priority: 10,
    url: (env) => `${base(env.OLLAMA_BASE_URL, 'http://localhost:11434/v1')}/embeddings`,
    modelVar: 'OLLAMA_EMBED_MODEL',
    models: [],
    maxBatch: 32,
  },
  {
    service: 'lmstudio',
    tier: 'local',
    priority: 20,
    url: (env) => `${base(env.LMSTUDIO_BASE_URL, 'http://localhost:1234/v1')}/embeddings`,
    modelVar: 'LMSTUDIO_EMBED_MODEL',
    models: [],
    maxBatch: 32,
  },
  {
    service: 'local',
    tier: 'local',
    priority: 30,
    url: (env) => `${base(env.LOCAL_EMBED_BASE_URL, '')}/embeddings`,
    keyVar: 'LOCAL_EMBED_API_KEY',
    modelVar: 'LOCAL_EMBED_MODEL',
    models: [],
    alsoRequires: ['LOCAL_EMBED_BASE_URL'],
    maxBatch: 32,
  },
  // ---- free: hosted free tiers with your own key (none verified live: no key on the build machine, except Cloudflare)
  {
    service: 'gemini',
    tier: 'free',
    priority: 10,
    url: () => 'https://generativelanguage.googleapis.com/v1beta/openai/embeddings',
    keyVar: 'GEMINI_API_KEY',
    modelVar: 'GEMINI_EMBED_MODEL',
    models: ['gemini-embedding-2'],
    maxBatch: 32,
  },
  {
    service: 'jina',
    tier: 'free',
    priority: 20,
    url: () => 'https://api.jina.ai/v1/embeddings',
    keyVar: 'JINA_API_KEY',
    modelVar: 'JINA_EMBED_MODEL',
    models: ['jina-embeddings-v3'],
    maxBatch: 32,
    // The free tier allows 100K tokens per minute.
    maxBatchTokens: 50_000,
    modeBody: (mode) => ({ task: mode === 'query' ? 'retrieval.query' : 'retrieval.passage' }),
    noPrefixes: true,
  },
  {
    // Workers AI REST through its OpenAI-compatible route. The binding variant belongs to provider-cloudflare-ai.
    service: 'cloudflare',
    tier: 'free',
    priority: 30,
    url: (env) => `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID ?? ''}/ai/v1/embeddings`,
    keyVar: 'CLOUDFLARE_API_TOKEN',
    pooled: false,
    modelVar: 'CLOUDFLARE_EMBED_MODEL',
    models: ['@cf/baai/bge-m3'],
    alsoRequires: ['CLOUDFLARE_ACCOUNT_ID'],
    maxBatch: 100,
  },
  {
    service: 'mistral',
    tier: 'free',
    priority: 40,
    url: () => 'https://api.mistral.ai/v1/embeddings',
    keyVar: 'MISTRAL_API_KEY',
    modelVar: 'MISTRAL_EMBED_MODEL',
    models: ['mistral-embed'],
    // Mistral does not publish per-request limits; these stay well inside what its users report.
    maxBatch: 32,
    maxBatchTokens: 16_000,
  },
  // ---- keyless: hosted, no key; 2 requests per minute per model per IP, 25 inputs per request (both measured)
  {
    service: 'ovh',
    tier: 'keyless',
    priority: 10,
    url: () => OVH,
    modelVar: 'OVH_EMBED_MODEL',
    models: ['bge-m3', 'Qwen3-Embedding-8B'],
    maxBatch: 25,
  },
  // ---- paid: last backstop, only when the key is set
  {
    service: 'openai',
    tier: 'paid',
    priority: 10,
    url: (env) => `${base(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')}/embeddings`,
    keyVar: 'OPENAI_API_KEY',
    modelVar: 'OPENAI_EMBED_MODEL',
    models: ['text-embedding-3-small'],
    // OpenAI allows 2048 inputs and 300,000 tokens per request.
    maxBatch: 512,
    maxBatchTokens: 250_000,
  },
];

function modelsFor(lane: Lane, env: Env): string[] {
  const override = (env[lane.modelVar] ?? '').trim();
  return override ? [override] : lane.models;
}

function makeRung(
  lane: Lane,
  env: Env,
  model: string,
  i: number,
  opts: { service: string; key?: string; requires: string[]; enabled: boolean },
): RetrievalEmbedRung {
  const info = modelInfo(model);
  const ep: EmbedEndpoint = { url: lane.url(env), model, key: opts.key, label: opts.service };
  return makeEmbedRung({
    id: model ? `embed/${opts.service}/${model}` : `embed/${opts.service}`,
    provider: PROVIDER_ID,
    service: opts.service,
    model,
    tier: lane.tier,
    priority: lane.priority + i,
    quality: info.quality,
    requires: opts.requires,
    enabled: opts.enabled,
    dimensions: info.dimensions,
    maxInputTokens: info.maxInputTokens,
    maxBatch: lane.maxBatch,
    maxBatchTokens: lane.maxBatchTokens,
    prefixes: lane.noPrefixes ? { query: '', passage: '' } : undefined,
    embedBatch: (texts, mode, ctx) => postEmbeddings(ep, texts, ctx, lane.modeBody?.(mode)),
  });
}

function laneRungs(lane: Lane, env: Env): RetrievalEmbedRung[] {
  const models = modelsFor(lane, env);
  const extra = lane.alsoRequires ?? [];
  const extraSet = extra.every((v) => Boolean(env[v]));

  // Local lanes: enabled by naming the model.
  if (lane.models.length === 0) {
    const requires = [lane.modelVar, ...extra];
    const model = models[0];
    if (!model) return [makeRung(lane, env, '', 0, { service: lane.service, requires, enabled: false })];
    const key = lane.keyVar ? env[lane.keyVar] || undefined : undefined;
    return [makeRung(lane, env, model, 0, { service: lane.service, key, requires, enabled: extraSet })];
  }

  if (!lane.keyVar) {
    return models.map((m, i) => makeRung(lane, env, m, i, { service: lane.service, requires: extra, enabled: extraSet }));
  }

  const keyVar = lane.keyVar;
  const all = keyPool(env, keyVar);
  const keys = lane.pooled === false ? all.slice(0, 1) : all;
  if (keys.length === 0) {
    return models.map((m, i) =>
      makeRung(lane, env, m, i, { service: lane.service, requires: [keyVar, ...extra], enabled: false }),
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

/** Every HTTP embedding rung, enabled or not, built from env (no network). */
export function embedRungs(env: Env): RetrievalEmbedRung[] {
  return LANES.flatMap((lane) => laneRungs(lane, env));
}
