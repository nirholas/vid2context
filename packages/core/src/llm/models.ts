/**
 * The model catalog: every rung the registry knows, enabled or not, in the
 * shape a model picker shows (docs/prompts/SHARED-CONTRACTS.md section 3,
 * ModelInfo). Built from env only: no network, and no env values in the
 * output, only the names of the variables a rung needs.
 */
import { isRungEnabled, keylessAllowed } from '../chain.ts';
import { canStream } from '../llm-stream.ts';
import type { LlmRung, Rung } from '../provider.ts';
import type { Registry } from '../registry.ts';
import type { Env, Tier } from '../types.ts';

export type ModelKind = 'llm' | 'stt' | 'embed' | 'video' | 'visual';

export interface ModelInfo {
  /** Rung id. Pass it back as ChatApiRequest.model.rung. */
  id: string;
  kind: ModelKind;
  /** Display name: the model id without vendor prefixes, e.g. "gpt-oss-120b". */
  label: string;
  /** Upstream service: 'groq', 'ovh', 'ollama', 'anthropic'. Pooled keys look like 'groq#2'. */
  service: string;
  provider: string;
  model: string;
  tier: Tier;
  quality: number;
  /** Rung capabilities plus 'stream' when the rung streams natively. */
  capabilities: string[];
  contextTokens?: number;
  enabled: boolean;
  /** Env var NAMES the rung needs. Never values. */
  requires: string[];
}

export interface ModelGroup {
  tier: Tier;
  services: { service: string; models: ModelInfo[] }[];
}

const KINDS: ModelKind[] = ['llm', 'stt', 'embed', 'video', 'visual'];
const TIER_ORDER: Record<Tier, number> = { local: 0, free: 1, keyless: 2, paid: 3 };

/** The model id without vendor or path prefixes: 'openai/gpt-oss-120b' and '@cf/openai/gpt-oss-120b' become 'gpt-oss-120b'. */
export function modelLabel(model: string, service: string): string {
  const last = model.split('/').filter(Boolean).pop();
  return last || service;
}

/** Paid rungs are off when VID2CONTEXT_ALLOW_PAID is 0 or false, as in the chain. */
function paidAllowed(env: Env): boolean {
  const v = env.VID2CONTEXT_ALLOW_PAID;
  return !(v === '0' || v === 'false');
}

/** Whether the chain would use this rung under env: its own check plus the keyless and paid switches. */
export function modelEnabled(rung: Rung, env: Env): boolean {
  if (!isRungEnabled(rung, env)) return false;
  if (rung.tier === 'keyless' && !keylessAllowed(env)) return false;
  if (rung.tier === 'paid' && !paidAllowed(env)) return false;
  return true;
}

function rungsOf(registry: Registry, env: Env, kind: ModelKind): Rung[] {
  switch (kind) {
    case 'llm':
      return registry.llmRungs(env);
    case 'stt':
      return registry.sttRungs(env);
    case 'embed':
      return registry.embedRungs(env);
    case 'video':
      return registry.videoRungs(env);
    case 'visual':
      return registry.visualRungs(env);
  }
}

function toInfo(rung: Rung, kind: ModelKind, env: Env): ModelInfo {
  const capabilities = [...rung.capabilities];
  if (kind === 'llm' && canStream(rung as LlmRung) && !capabilities.includes('stream')) capabilities.push('stream');
  const contextTokens = (rung as Partial<LlmRung>).contextTokens;
  return {
    id: rung.id,
    kind,
    label: modelLabel(rung.model, rung.service),
    service: rung.service,
    provider: rung.provider,
    model: rung.model,
    tier: rung.tier,
    quality: rung.quality,
    capabilities,
    ...(typeof contextTokens === 'number' ? { contextTokens } : {}),
    enabled: modelEnabled(rung, env),
    requires: [...rung.requires],
  };
}

/**
 * Every model the registry knows for `kind` (default: all kinds), enabled or
 * not, sorted by kind and then the default free-first order: tier (local,
 * free, keyless, paid), priority, then quality.
 */
export function listModels(registry: Registry, env: Env, opts: { kind?: ModelKind } = {}): ModelInfo[] {
  const kinds = opts.kind ? [opts.kind] : KINDS;
  const out: ModelInfo[] = [];
  for (const kind of kinds) {
    const rungs = [...rungsOf(registry, env, kind)].sort(
      (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.priority - b.priority || b.quality - a.quality,
    );
    for (const r of rungs) out.push(toInfo(r, kind, env));
  }
  return out;
}

/** Group models by tier (in tier order), then by service (in first-seen order), keeping the list order inside each group. */
export function groupModels(models: ModelInfo[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const m of models) {
    let g = groups.find((x) => x.tier === m.tier);
    if (!g) {
      g = { tier: m.tier, services: [] };
      groups.push(g);
    }
    let s = g.services.find((x) => x.service === m.service);
    if (!s) {
      s = { service: m.service, models: [] };
      g.services.push(s);
    }
    s.models.push(m);
  }
  return groups.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
}
