/**
 * LLM plumbing for server-side synthesis: token budgets from the ranked
 * rungs' context windows, JSON calls through the core chain, and a record of
 * which rung served each step.
 */
import {
  type Attempt,
  attemptsOf,
  type ChainOptions,
  type ChatMessage,
  type Ctx,
  chat,
  rankRungs,
  type Registry,
  Vid2ContextError,
} from '@vid2context/core';
import type { RungUse, Step } from './types.ts';

/** Never send more than this many source tokens in one call, even to huge windows: keyless hosts are slow on big prompts. */
export const MAX_CHUNK_TOKENS = 24_000;
/** Window assumed for a rung that does not declare contextTokens. */
export const UNKNOWN_CONTEXT_TOKENS = 8_192;
export const DEFAULT_OUTPUT_TOKENS = 4_000;
/** Instructions, schema and fence lines around the sources. */
export const PROMPT_OVERHEAD_TOKENS = 1_500;
/** Share of the window used for input, leaving headroom for estimate error. */
const HEADROOM = 0.75;

export function withJson(chain: ChainOptions | undefined): ChainOptions {
  const needs = [...(chain?.needs ?? [])];
  if (!needs.includes('json')) needs.push('json');
  return { ...chain, needs };
}

/**
 * Source tokens one call may carry: from the first rung the chain would try,
 * with headroom for the prompt and the answer, capped at MAX_CHUNK_TOKENS.
 */
export function sourceBudget(registry: Registry, ctx: Ctx, chain: ChainOptions | undefined, opts: { maxChunkTokens?: number; maxOutputTokens?: number }): number {
  const ranked = rankRungs(registry.llmRungs(ctx.env), withJson(chain), ctx.env);
  if (ranked.length === 0) {
    throw new Vid2ContextError('no-provider', 'No LLM rung with JSON output is enabled for server-side synthesis.', {
      hint: 'Keyless lanes (OVH, Pollinations) need VID2CONTEXT_KEYLESS unset; or set a free key such as GROQ_API_KEY (docs/providers.md). Agent-side synthesis (briefPrompt) needs no rung at all.',
    });
  }
  const window = ranked[0]?.contextTokens ?? UNKNOWN_CONTEXT_TOKENS;
  const output = opts.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
  const fromWindow = Math.floor(window * HEADROOM) - output - PROMPT_OVERHEAD_TOKENS;
  const budget = Math.min(MAX_CHUNK_TOKENS, fromWindow, opts.maxChunkTokens ?? Number.POSITIVE_INFINITY);
  if (budget < 500) {
    throw new Vid2ContextError('too-large', `The first LLM rung (${ranked[0]?.id}) has too small a context window for synthesis.`, {
      hint: 'Use a rung with a larger window (ChainOptions.only), or lower maxOutputTokens.',
    });
  }
  return budget;
}

/** Parse the first JSON object in a model answer, tolerating code fences and text around it. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  for (const candidate of [unfenced, unfenced.slice(unfenced.indexOf('{'), unfenced.lastIndexOf('}') + 1)]) {
    try {
      const v = JSON.parse(candidate) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Accumulates rung use and attempts across the steps of one brief or extraction. */
export class Ledger {
  readonly rungs: RungUse[] = [];
  readonly attempts: Attempt[] = [];
  readonly notes: string[] = [];
}

export interface JsonCall {
  step: Step;
  messages: ChatMessage[];
  chain?: ChainOptions;
  maxTokens?: number;
  videoId?: string;
  chunk?: number;
}

export interface JsonAnswer {
  value: Record<string, unknown> | null;
  text: string;
  rung: string;
}

/**
 * One JSON call through the chain. An answer that is not a JSON object is
 * retried once on the next rung (skipping the one that produced it). Returns
 * value null when the retry is unparseable too, so callers decide.
 */
export async function chatJson(registry: Registry, call: JsonCall, ledger: Ledger, ctx: Ctx): Promise<JsonAnswer> {
  const chain = withJson(call.chain);
  let skip = chain.skip ?? [];
  let last: JsonAnswer | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Awaited<ReturnType<typeof chat>>;
    try {
      res = await chat(
        registry,
        { messages: call.messages, json: true, temperature: 0.2, maxTokens: call.maxTokens ?? DEFAULT_OUTPUT_TOKENS },
        { ...chain, skip },
        ctx,
      );
    } catch (err) {
      ledger.attempts.push(...attemptsOf(err));
      if (last) return last;
      throw err;
    }
    ledger.attempts.push(...res.attempts);
    ledger.rungs.push({
      step: call.step,
      rung: res.rung,
      model: res.model,
      ...(call.videoId ? { videoId: call.videoId } : {}),
      ...(call.chunk !== undefined ? { chunk: call.chunk } : {}),
    });
    const value = parseJsonObject(res.text);
    last = { value, text: res.text, rung: res.rung };
    if (value) return last;
    ledger.attempts.push({ id: res.rung, stage: 'llm', outcome: 'error', reason: 'bad-json', detail: res.text.slice(0, 200) });
    ctx.log.warn('LLM answer was not a JSON object, trying the next rung', { rung: res.rung, step: call.step });
    skip = [...skip, res.rung];
  }
  return last as JsonAnswer;
}
