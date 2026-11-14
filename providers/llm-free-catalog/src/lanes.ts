/**
 * The free LLM catalog: every free or keyless OpenAI-compatible service the
 * foundation package (providers/llm-openai-compatible) does not already ship.
 *
 *   keyless  Kilo Code gateway, Nemotron `:free` models (KILO_API_KEY optional)
 *   free     NVIDIA NIM, SambaNova Cloud, Cloudflare Workers AI REST, Zhipu
 *            (Z.ai) GLM Flash, SiliconFlow
 *
 * Each model is its own rung (most free tiers meter quota per model) and each
 * pooled key adds one more. Priorities sit among the foundation's free rungs:
 * Groq 10, Cerebras 20, NVIDIA 30, SambaNova 40, Cloudflare 45, Mistral 50,
 * Zhipu 55, GitHub 60, Gemini 70, SiliconFlow 80 (an 8B step-down), Groq
 * gpt-oss-20b 90. Kilo runs before OVH (10) and Pollinations (20) in the
 * keyless tier: its quota (about 200 requests per hour) is far larger than
 * OVH's 2 requests per minute. With KILO_API_KEY it becomes a free-tier lane
 * at 35, between NVIDIA and SambaNova.
 */
import { type Env, keyPool, type LlmRung, type PooledKey, pooledService, type Tier } from '@vid2context/core';
import { type CatalogEndpoint, chatVia, type LaneLimits } from './client.ts';

export const PROVIDER_ID = 'llm-free-catalog';

export interface CatalogModel {
  id: string;
  quality: number;
  contextTokens?: number;
  maxOutputTokens?: number;
  /** response_format json_object verified live on this model. */
  json?: boolean;
  /** response_format json_schema verified live on this model. */
  jsonSchema?: boolean;
}

interface Credential {
  service: string;
  key?: string;
  /** Base URL for this credential (Cloudflare embeds the account id). */
  baseUrl: string;
  requires: string[];
  enabled: boolean;
}

export interface CatalogLane {
  service: string;
  tier: Exclude<Tier, 'local' | 'paid'>;
  priority: number;
  /** Base URL without /chat/completions; null when it cannot be built from env yet. */
  baseUrl: (env: Env) => string | null;
  /** Env var for the key. Required for 'free' lanes, optional for keyless ones. */
  keyVar?: string;
  modelVar: string;
  models: CatalogModel[];
  extraBody?: Record<string, unknown>;
  limits?: Omit<LaneLimits, 'maxOutputTokens'>;
  timeoutMs?: number;
  /** Build credentials from env instead of the default key pool (Cloudflare). */
  credentials?: (lane: CatalogLane, env: Env) => Credential[];
  /**
   * With a key set, a model whose id lacks ':free' could bill the account, so
   * its rung is tier 'paid' (Kilo's gateway also serves paid models).
   */
  freeSuffixOnly?: boolean;
  /** Priority in the free tier when a keyless lane is used with an account key. */
  keyedPriority?: number;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * Cloudflare Workers AI: the URL embeds the account id. CLOUDFLARE_API_TOKEN
 * uses CLOUDFLARE_ACCOUNT_ID; each CLOUDFLARE_FALLBACK_KEYS entry is either a
 * token for the same account or `<account_id>:<token>` for another account
 * (each account has its own daily neuron allocation).
 */
function cloudflareCredentials(lane: CatalogLane, env: Env): Credential[] {
  const account = (env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const urlFor = (id: string) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1`;
  const pool: PooledKey[] = keyPool(env, 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_FALLBACK_KEYS');
  if (pool.length === 0) {
    return [
      {
        service: lane.service,
        baseUrl: urlFor(account || 'unset'),
        requires: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
        enabled: false,
      },
    ];
  }
  return pool.map((k) => {
    const m = /^([0-9a-f]{32}):(.+)$/i.exec(k.key);
    const id = m ? (m[1] as string) : account;
    const key = m ? (m[2] as string) : k.key;
    const requires = m ? [k.envVar] : ['CLOUDFLARE_ACCOUNT_ID', k.envVar];
    return {
      service: pooledService(lane.service, k.index),
      key,
      baseUrl: urlFor(id || 'unset'),
      requires,
      enabled: Boolean(id),
    };
  });
}

export const CATALOG_LANES: CatalogLane[] = [
  // ---- keyless: Kilo Code's gateway serves free Nemotron routes with no key
  // (verified 2026-11-14). Kilo routes reasoning by default and the answer can
  // then land in the reasoning field; `reasoning.enabled: false` keeps it in
  // content. A key (KILO_API_KEY) only raises the limits.
  {
    service: 'kilo',
    tier: 'keyless',
    priority: 5,
    baseUrl: (env) => trimSlash(env.KILO_BASE_URL || 'https://api.kilo.ai/api/gateway'),
    keyVar: 'KILO_API_KEY',
    modelVar: 'KILO_MODEL',
    models: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', quality: 4, contextTokens: 1_000_000, maxOutputTokens: 65_536, json: true },
      { id: 'nvidia/nemotron-3.5-super-vl:free', quality: 4, contextTokens: 1_000_000, maxOutputTokens: 131_072 },
      { id: 'nvidia/nemotron-3.5-lightning:free', quality: 3, contextTokens: 1_000_000, maxOutputTokens: 65_536, json: true },
    ],
    extraBody: { reasoning: { enabled: false } },
    freeSuffixOnly: true,
    keyedPriority: 35,
  },
  // ---- free: hosted free tiers with your own key
  // NVIDIA NIM (build.nvidia.com). Nemotron 3 leaks its chain of thought into
  // content unless thinking is off. The free queue can hold requests a long
  // time under load, so the lane has a tighter timeout than the default.
  {
    service: 'nvidia',
    tier: 'free',
    priority: 30,
    baseUrl: (env) => trimSlash(env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'),
    keyVar: 'NVIDIA_API_KEY',
    modelVar: 'NVIDIA_MODEL',
    models: [{ id: 'nvidia/nemotron-3-super-120b-a12b', quality: 4, contextTokens: 131_072 }],
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
    limits: { temperature: { min: 0, max: 1 } },
    timeoutMs: 45_000,
  },
  // SambaNova Cloud: Llama 3.3 70B accepts at most 3072 output tokens
  // (max_completion_tokens in GET /v1/models, 2026-11-14).
  {
    service: 'sambanova',
    tier: 'free',
    priority: 40,
    baseUrl: (env) => trimSlash(env.SAMBANOVA_BASE_URL || 'https://api.sambanova.ai/v1'),
    keyVar: 'SAMBANOVA_API_KEY',
    modelVar: 'SAMBANOVA_MODEL',
    models: [{ id: 'Meta-Llama-3.3-70B-Instruct', quality: 3, contextTokens: 131_072, maxOutputTokens: 3072 }],
    limits: { temperature: { min: 0, max: 1 } },
  },
  // Cloudflare Workers AI REST through the OpenAI-compatible endpoint (10,000
  // free neurons per day). JSON and JSON Schema verified live 2026-11-14.
  // Workers AI stops at a small default output length, so a default is sent.
  {
    service: 'cloudflare',
    tier: 'free',
    priority: 45,
    baseUrl: () => null,
    modelVar: 'CLOUDFLARE_MODEL',
    models: [
      {
        id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        quality: 3,
        contextTokens: 24_000,
        json: true,
        jsonSchema: true,
      },
    ],
    limits: { defaultMaxTokens: 2048, temperature: { min: 0, max: 5 } },
    credentials: cloudflareCredentials,
  },
  // Zhipu (Z.ai international; set ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4
  // for the mainland endpoint). GLM Flash models are permanently free.
  {
    service: 'zhipu',
    tier: 'free',
    priority: 55,
    baseUrl: (env) => trimSlash(env.ZHIPU_BASE_URL || 'https://api.z.ai/api/paas/v4'),
    keyVar: 'ZHIPU_API_KEY',
    modelVar: 'ZHIPU_MODEL',
    models: [{ id: 'glm-4.7-flash', quality: 3, contextTokens: 200_000 }],
    extraBody: { thinking: { type: 'disabled' } },
    limits: { temperature: { min: 0, max: 1 } },
  },
  // SiliconFlow international (set SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
  // for the mainland endpoint). Qwen3 8B is in its free model set; a
  // capability step-down, so it runs late in the free tier.
  {
    service: 'siliconflow',
    tier: 'free',
    priority: 80,
    baseUrl: (env) => trimSlash(env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.com/v1'),
    keyVar: 'SILICONFLOW_API_KEY',
    modelVar: 'SILICONFLOW_MODEL',
    models: [{ id: 'Qwen/Qwen3-8B', quality: 2, contextTokens: 131_072 }],
    extraBody: { enable_thinking: false },
    limits: { temperature: { min: 0, max: 2 } },
  },
];

/** The lane's models, replaced by `<PROVIDER>_MODEL` when set (comma-separated, in order). */
export function modelsFor(lane: CatalogLane, env: Env): CatalogModel[] {
  const override = (env[lane.modelVar] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (override.length === 0) return lane.models;
  return override.map((id) => lane.models.find((m) => m.id === id) ?? { id, quality: 3 });
}

function defaultCredentials(lane: CatalogLane, env: Env): Credential[] {
  const base = lane.baseUrl(env) ?? '';
  if (!lane.keyVar) return [{ service: lane.service, baseUrl: base, requires: [], enabled: true }];
  const pool = keyPool(env, lane.keyVar);
  if (pool.length === 0) {
    if (lane.tier === 'keyless') return [{ service: lane.service, baseUrl: base, requires: [], enabled: true }];
    return [{ service: lane.service, baseUrl: base, requires: [lane.keyVar], enabled: false }];
  }
  return pool.map((k) => ({
    service: pooledService(lane.service, k.index),
    key: k.key,
    baseUrl: base,
    requires: [k.envVar],
    enabled: true,
  }));
}

function tierFor(lane: CatalogLane, model: CatalogModel, cred: Credential): Tier {
  if (!cred.key) return lane.tier;
  if (lane.freeSuffixOnly && !model.id.endsWith(':free')) return 'paid';
  // A keyless lane used with an account key is that account's free tier.
  return 'free';
}

export function laneRungs(lane: CatalogLane, env: Env): LlmRung[] {
  const creds = (lane.credentials ?? defaultCredentials)(lane, env);
  const models = modelsFor(lane, env);
  return creds.flatMap((cred) =>
    models.map((model, i): LlmRung => {
      const ep: CatalogEndpoint = {
        url: `${cred.baseUrl}/chat/completions`,
        model: model.id,
        key: cred.key,
        label: cred.service,
        jsonSchema: model.jsonSchema,
        extraBody: lane.extraBody,
        timeoutMs: lane.timeoutMs,
        limits: { ...lane.limits, maxOutputTokens: model.maxOutputTokens },
      };
      const capabilities = [...(model.json || model.jsonSchema ? ['json'] : []), ...(model.jsonSchema ? ['json-schema'] : [])];
      const keyed = Boolean(cred.key) && lane.tier === 'keyless';
      return {
        id: `llm/${cred.service}/${model.id}`,
        provider: PROVIDER_ID,
        service: cred.service,
        model: model.id,
        tier: tierFor(lane, model, cred),
        priority: (keyed ? (lane.keyedPriority ?? lane.priority) : lane.priority) + i,
        quality: model.quality,
        capabilities,
        requires: cred.requires,
        isEnabled: () => cred.enabled,
        contextTokens: model.contextTokens,
        chat: (req, ctx) => chatVia(ep, req, ctx),
      };
    }),
  );
}

export function catalogRungs(env: Env): LlmRung[] {
  return CATALOG_LANES.flatMap((lane) => laneRungs(lane, env));
}
