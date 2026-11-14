/**
 * Model list helpers for the picker: explain why a row is disabled, group
 * rows by tier and service, filter them by a search query, and format labels.
 * In client-only mode the list itself comes from core's listModels over the
 * browser registry, the same function GET /api/v1/models uses.
 */
import type { Env, Tier } from '@vid2context/core';
import { browserCorsFor } from './cors.ts';
import type { ModelInfo, ModelRow } from './types.ts';

export const TIER_ORDER: Tier[] = ['local', 'free', 'keyless', 'paid'];

export const TIER_LABEL: Record<Tier, string> = {
  local: 'Local',
  free: 'Free',
  keyless: 'Keyless',
  paid: 'Paid',
};

const SERVICE_LABEL: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  local: 'Local server',
  groq: 'Groq',
  cerebras: 'Cerebras',
  mistral: 'Mistral',
  github: 'GitHub Models',
  gemini: 'Gemini',
  ovh: 'OVH',
  pollinations: 'Pollinations',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  cloudflare: 'Cloudflare',
  webllm: 'WebLLM',
  'chrome-ai': 'Chrome built-in AI',
  llamacpp: 'llama.cpp',
  vllm: 'vLLM',
  jan: 'Jan',
  localai: 'LocalAI',
  kilo: 'Kilo',
  nvidia: 'NVIDIA',
  sambanova: 'SambaNova',
  zhipu: 'Zhipu',
  siliconflow: 'SiliconFlow',
  'cloudflare-binding': 'Workers AI binding',
  'gemini-native': 'Gemini (native)',
  'vertex-gemini': 'Vertex AI Gemini',
  'vertex-anthropic': 'Vertex AI Claude',
};

/** 'groq#2' -> 'groq'. */
export function baseService(service: string): string {
  return service.replace(/#\d+$/, '');
}

/** 'groq#2' -> 'Groq (key 2)'. */
export function serviceLabel(service: string): string {
  const base = baseService(service);
  const name = SERVICE_LABEL[base] ?? base.charAt(0).toUpperCase() + base.slice(1);
  const pool = /#(\d+)$/.exec(service)?.[1];
  return pool ? `${name} (key ${pool})` : name;
}

/** 'openai/gpt-oss-120b' -> 'gpt-oss-120b', 'meta/Llama-3.3-70B-Instruct' -> 'Llama-3.3-70B-Instruct'. */
export function modelLabel(model: string, service: string): string {
  if (!model) return `${serviceLabel(service)} (set a model)`;
  const parts = model.split('/');
  return parts[parts.length - 1] || model;
}

/** 131072 -> '128K', 1048576 -> '1M', 65536 -> '64K', 8000 -> '8K'. */
export function formatContextTokens(n: number | undefined): string | undefined {
  if (!n || n <= 0) return undefined;
  if (n >= 1_000_000) {
    const m = n / 1_048_576;
    const v = Number.isInteger(Math.round(m * 10) / 10) ? Math.round(m) : Math.round(m * 10) / 10;
    return `${v}M`;
  }
  const k = n % 1024 === 0 ? n / 1024 : n / 1000;
  return `${Math.round(k)}K`;
}

export type Mode = 'server' | 'client';

/**
 * Explain why a row cannot be picked. Server mode cannot see the server's env,
 * so it names every variable the rung requires; client-only mode names only
 * the ones missing from the browser's saved keys, and also refuses services
 * whose API blocks browser requests (CORS).
 */
export function toModelRows(models: ModelInfo[], mode: Mode, env: Env = {}): ModelRow[] {
  return models.map((source) => {
    // Rungs with no model yet (a local server before its *_MODEL is set) read better as "Ollama (set a model)".
    const m = source.model ? source : { ...source, label: modelLabel('', source.service) };
    let note: string | undefined;
    if (mode === 'client') {
      const cors = browserCorsFor(m.service, m.provider, m.tier);
      if (cors.status === 'blocked') return { ...m, enabled: false, disabledReason: cors.reason };
      if (cors.status === 'needs-config') note = cors.reason;
    }
    if (m.enabled) return note ? { ...m, note } : { ...m };
    const missing = mode === 'client' ? m.requires.filter((k) => !env[k]) : m.requires;
    if (missing.length > 0) return { ...m, disabledReason: `Needs ${missing.join(', ')}` };
    if (m.tier === 'keyless') return { ...m, disabledReason: 'Keyless rungs are off (VID2CONTEXT_KEYLESS=0)' };
    return { ...m, disabledReason: 'Not available in this runtime' };
  });
}

export interface ServiceGroup {
  service: string;
  label: string;
  models: ModelRow[];
}

export interface TierGroup {
  tier: Tier;
  label: string;
  services: ServiceGroup[];
}

/** Tiers in free-first order; services and models keep the order they came in (the server's ranking). */
export function groupModels(rows: ModelRow[]): TierGroup[] {
  const out: TierGroup[] = [];
  for (const tier of TIER_ORDER) {
    const inTier = rows.filter((r) => r.tier === tier);
    if (inTier.length === 0) continue;
    const services: ServiceGroup[] = [];
    for (const row of inTier) {
      const key = baseService(row.service);
      let group = services.find((s) => s.service === key);
      if (!group) {
        group = { service: key, label: serviceLabel(key), models: [] };
        services.push(group);
      }
      group.models.push(row);
    }
    out.push({ tier, label: TIER_LABEL[tier], services });
  }
  return out;
}

export const CAPABILITY_LABEL: Record<string, string> = {
  vision: 'Vision: reads images',
  video: 'Video: watches whole videos',
  tools: 'Tools: function calling',
  json: 'JSON output',
  'json-schema': 'Structured output (JSON Schema)',
  reasoning: 'Reasoning: thinks before answering',
  stream: 'Streaming: tokens arrive as they are written',
};

/** Every whitespace-separated term must match the label, model, service, tier or a capability. */
export function filterModels(rows: ModelRow[], query: string): ModelRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((r) => {
    const hay = [
      r.label,
      r.model,
      r.service,
      serviceLabel(r.service),
      r.provider,
      r.tier,
      TIER_LABEL[r.tier],
      ...r.capabilities,
      ...r.capabilities.map((c) => CAPABILITY_LABEL[c] ?? ''),
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** The rung Auto would try first: the first enabled row in free-first order. */
export function autoPick(rows: ModelRow[]): ModelRow | undefined {
  for (const tier of TIER_ORDER) {
    const hit = rows.find((r) => r.tier === tier && r.enabled);
    if (hit) return hit;
  }
  return undefined;
}
