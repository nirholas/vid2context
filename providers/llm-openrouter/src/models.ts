/**
 * The OpenRouter free-model picker. OpenRouter retires `:free` ids without
 * notice, so nothing here pins one: the live catalog (GET /api/v1/models, no
 * key needed) is fetched, filtered to models that are free on both prompt and
 * completion and whose id ends in ':free', ranked, and cached for an hour.
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const CACHE_MS = 60 * 60 * 1000;
/** Free models with a smaller window are too tight for transcripts. */
const MIN_CONTEXT = 32_768;

/**
 * Strong open families, best first. A small nudge, not a pin: context length
 * and recency still decide among them, and new families can rank on those alone.
 */
export const PREFERRED_FAMILIES = [
  'google/gemma',
  'nvidia/nemotron',
  'qwen/',
  'deepseek/',
  'meta-llama/',
  'mistralai/',
  'openai/gpt-oss',
  'z-ai/',
  'moonshotai/',
];

export interface OpenRouterModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  architecture?: { input_modalities?: string[] | null; output_modalities?: string[] | null };
  pricing?: { prompt?: string; completion?: string };
}

export interface FreeModel {
  id: string;
  contextLength: number;
  created: number;
  score: number;
}

/** Parameter count in billions from ids like 'lfm-3-1.7b', 'qwen3-8b', 'gemma-4-31b-it'; undefined when the id does not say. */
function paramsB(id: string): number | undefined {
  const m = /[-/](\d+(?:\.\d+)?)b(?:[-:]|$)/i.exec(id);
  return m ? Number(m[1]) : undefined;
}

function isFree(m: OpenRouterModel): boolean {
  return m.id.endsWith(':free') && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0;
}

function isTextChat(m: OpenRouterModel): boolean {
  const input = m.architecture?.input_modalities;
  const output = m.architecture?.output_modalities;
  return (!input || input.includes('text')) && (!output || output.includes('text'));
}

/** Score one free model: longer context, newer release and a preferred family rank higher; tiny models rank last. */
export function scoreModel(m: OpenRouterModel, nowSec: number): number {
  const ctx = m.context_length ?? 0;
  const ctxScore = Math.min(Math.max(Math.log2(ctx / 8192), 0), 7);
  const ageDays = m.created ? Math.max(0, (nowSec - m.created) / 86_400) : 365;
  const recencyScore = Math.min(Math.max(4 - ageDays / 90, 0), 4);
  const family = PREFERRED_FAMILIES.findIndex((f) => m.id.startsWith(f));
  const familyScore = family === -1 ? 0 : 3 - family * 0.25;
  const p = paramsB(m.id);
  const sizePenalty = p === undefined ? 0 : p < 7 ? 6 : p < 20 ? 2 : 0;
  return Math.round((ctxScore + recencyScore + familyScore - sizePenalty) * 1000) / 1000;
}

/** Pure ranking of a models list (exported for tests). */
export function rankFreeModels(models: OpenRouterModel[], nowSec: number): FreeModel[] {
  return models
    .filter((m) => isFree(m) && isTextChat(m) && (m.context_length ?? 0) >= MIN_CONTEXT)
    .map((m) => ({ id: m.id, contextLength: m.context_length ?? 0, created: m.created ?? 0, score: scoreModel(m, nowSec) }))
    .sort((a, b) => b.score - a.score || b.created - a.created || a.id.localeCompare(b.id));
}

const cache = new Map<string, { at: number; models: FreeModel[] }>();

export function clearFreeModelCache(): void {
  cache.clear();
}

/** The ranked free models from the live catalog, cached in memory for one hour per base URL. */
export async function pickFreeModels(ctx: Ctx, baseUrl: string = OPENROUTER_BASE): Promise<FreeModel[]> {
  const hit = cache.get(baseUrl);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.models;
  const res = await fetchWithTimeout(ctx, `${baseUrl}/models`, { headers: { accept: 'application/json' } }, 20_000);
  if (!res.ok) throw await errorFromResponse(res, 'openrouter models');
  const json = (await res.json()) as { data?: OpenRouterModel[] };
  if (!Array.isArray(json.data)) {
    throw new Vid2ContextError('upstream', 'openrouter models: the response has no data array.', {
      hint: 'OpenRouter changed its models API; set OPENROUTER_MODEL to explicit ids meanwhile.',
    });
  }
  const models = rankFreeModels(json.data, Math.floor(Date.now() / 1000));
  cache.set(baseUrl, { at: Date.now(), models });
  return models;
}
