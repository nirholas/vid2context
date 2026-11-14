/**
 * OpenRouter rungs (OPENROUTER_API_KEY, pooled with OPENROUTER_FALLBACK_KEYS).
 *
 *   llm/openrouter/free-auto   picks the best live `:free` model at call time
 *                              and falls through to the next candidates (up to
 *                              3) when one is retired, rate-limited or failing
 *   llm/openrouter/<model>     one rung per id in OPENROUTER_MODEL; tier 'paid'
 *                              unless the id ends in ':free'
 *
 * Requests carry the HTTP-Referer and X-Title headers OpenRouter uses to
 * attribute traffic to an app.
 */
import {
  type ChatRequest,
  type ChatResult,
  type Ctx,
  defineProvider,
  type Env,
  keyPool,
  type LlmProvider,
  type LlmRung,
  pooledService,
  Vid2ContextError,
} from '@vid2context/core';
import { type CatalogEndpoint, chatVia } from '@vid2context/provider-llm-free-catalog';
import { OPENROUTER_BASE, pickFreeModels } from './models.ts';

export {
  clearFreeModelCache,
  type FreeModel,
  type OpenRouterModel,
  PREFERRED_FAMILIES,
  pickFreeModels,
  rankFreeModels,
  scoreModel,
} from './models.ts';

export const PROVIDER_ID = 'llm-openrouter';
export const FREE_AUTO = 'free-auto';
export const ATTRIBUTION_HEADERS = { 'HTTP-Referer': 'https://vid2context.com', 'X-Title': 'vid2context' };
/** Candidates tried per free-auto call before giving up. */
export const MAX_CANDIDATES = 3;

const KEY_VAR = 'OPENROUTER_API_KEY';

function baseUrl(env: Env): string {
  return (env.OPENROUTER_BASE_URL || OPENROUTER_BASE).replace(/\/+$/, '');
}

/** Candidates that just failed sit out for a while, per key, so the next call starts with one that may work. */
const benched = new Map<string, number>();

export function clearBench(): void {
  benched.clear();
}

function benchFor(err: Vid2ContextError): number {
  if (err.code === 'not-found') return 30 * 60_000;
  if (err.code === 'rate-limited') return Math.max(err.retryAfterSec ?? 60, 5) * 1000;
  return 30_000;
}

function fallsThrough(err: unknown): err is Vid2ContextError {
  return err instanceof Vid2ContextError && (err.code === 'not-found' || err.code === 'rate-limited' || err.code === 'upstream');
}

function endpoint(env: Env, service: string, key: string, model: string): CatalogEndpoint {
  return {
    url: `${baseUrl(env)}/chat/completions`,
    model,
    key,
    label: service,
    headers: ATTRIBUTION_HEADERS,
  };
}

/** One free-auto call: best cached candidate first, then the next ones on retired, rate-limited or upstream errors. */
async function freeAutoChat(env: Env, service: string, key: string, req: ChatRequest, ctx: Ctx): Promise<ChatResult> {
  const ranked = await pickFreeModels(ctx, baseUrl(env));
  const now = Date.now();
  const ready = ranked.filter((m) => (benched.get(`${service}|${m.id}`) ?? 0) <= now);
  const candidates = (ready.length > 0 ? ready : ranked).slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    throw new Vid2ContextError('not-found', 'openrouter: the live catalog lists no free chat model right now.', {
      hint: 'Set OPENROUTER_MODEL to an explicit model id, or rely on the other free rungs.',
    });
  }
  let last: Vid2ContextError | undefined;
  for (const m of candidates) {
    try {
      return await chatVia(endpoint(env, service, key, m.id), req, ctx);
    } catch (err) {
      if (!fallsThrough(err)) throw err;
      last = err;
      benched.set(`${service}|${m.id}`, Date.now() + benchFor(err));
      ctx.log.warn('openrouter free model failed, trying the next one', { model: m.id, reason: err.code });
    }
  }
  throw last as Vid2ContextError;
}

export function openrouterRungs(env: Env): LlmRung[] {
  const explicit = (env.OPENROUTER_MODEL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const keys = keyPool(env, KEY_VAR);
  const creds = keys.length > 0 ? keys : [{ key: '', envVar: KEY_VAR, index: 0 }];
  return creds.flatMap((k) => {
    const service = pooledService('openrouter', k.index);
    const enabled = Boolean(k.key);
    const auto: LlmRung = {
      id: `llm/${service}/${FREE_AUTO}`,
      provider: PROVIDER_ID,
      service,
      model: FREE_AUTO,
      tier: 'free',
      priority: 25,
      quality: 4,
      capabilities: [],
      requires: [k.envVar],
      isEnabled: () => enabled,
      // The picker drops free models under 32k tokens; most free models offer far more.
      contextTokens: 32_768,
      chat: (req, ctx) => freeAutoChat(env, service, k.key, req, ctx),
    };
    const pinned = explicit.map(
      (model, i): LlmRung => ({
        id: `llm/${service}/${model}`,
        provider: PROVIDER_ID,
        service,
        model,
        tier: model.endsWith(':free') ? 'free' : 'paid',
        priority: 26 + i,
        quality: 3,
        capabilities: [],
        requires: [k.envVar],
        isEnabled: () => enabled,
        chat: (req, ctx) => chatVia(endpoint(env, service, k.key, model), req, ctx),
      }),
    );
    return [auto, ...pinned];
  });
}

const provider: LlmProvider = defineProvider({
  id: PROVIDER_ID,
  kind: 'llm',
  name: 'OpenRouter (live free-model picker)',
  runtimes: ['node', 'workers', 'browser'],
  rungs: openrouterRungs,
});

export default provider;
