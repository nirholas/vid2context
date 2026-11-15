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
  type Registry,
  rankRungs,
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
export function sourceBudget(
  registry: Registry,
  ctx: Ctx,
  chain: ChainOptions | undefined,
  opts: { maxChunkTokens?: number; maxOutputTokens?: number },
): number {
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
    throw new Vid2ContextError(
      'too-large',
      `The first LLM rung (${ranked[0]?.id}) has too small a context window for synthesis.`,
      {
        hint: 'Use a rung with a larger window (ChainOptions.only), or lower maxOutputTokens.',
      },
    );
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

/**
 * Recover the complete part of a JSON object that was cut off mid-answer
 * (free rungs often stop at their output limit). Cuts after the last
 * complete object or array value and closes the brackets still open, so
 * every claim kept is one the model finished writing. Returns null when
 * nothing complete is left or the text is not a truncated object.
 */
export function salvageTruncatedJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let cut = -1;
  let cutStack: string[] = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return null; // complete object: not truncated, parseJsonObject handles it
      cut = i + 1;
      cutStack = [...stack];
    }
  }
  if (cut < 0 || stack.length === 0) return null;
  const closing = cutStack
    .reverse()
    .map((b) => (b === '{' ? '}' : ']'))
    .join('');
  try {
    const v = JSON.parse(text.slice(start, cut) + closing) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Wait after every rung was rate-limited: a little over the core chain's 60 s rate-limit cooldown. */
export const RATE_LIMIT_WAIT_MS = 62_000;
export const DEFAULT_RATE_LIMIT_RETRIES = 3;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** setTimeout-based sleep that rejects when the signal aborts. Runtime-neutral. */
export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Accumulates rung use and attempts across the steps of one brief or extraction, and holds the rate-limit policy. */
export class Ledger {
  readonly rungs: RungUse[] = [];
  readonly attempts: Attempt[] = [];
  readonly notes: string[] = [];
  readonly sleep: Sleep;
  readonly rateLimitRetries: number;

  constructor(opts: { sleep?: Sleep; rateLimitRetries?: number } = {}) {
    this.sleep = opts.sleep ?? sleep;
    this.rateLimitRetries = Math.max(0, opts.rateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES);
  }
}

/**
 * True when a chain failure was only rate limits: every rung tried answered
 * 429 (or a keyless host's free-limit 402) or was cooling down from one.
 * Waiting helps then; it does not for auth or upstream errors.
 */
export function onlyRateLimited(attempts: Attempt[]): boolean {
  const tried = attempts.filter((a) => a.outcome === 'error');
  if (tried.length === 0) return attempts.length > 0 && attempts.every((a) => a.reason === 'cooldown');
  return attempts.every(
    (a) =>
      a.reason === 'cooldown' ||
      a.reason?.startsWith('rate-limited') ||
      (a.reason === 'auth-402' && /free limit|FREE_LIMIT|rate/i.test(a.detail ?? '')),
  );
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

/** Rungs one JSON call may try when answers are not JSON objects (cut off by an output limit, prose, reasoning only). */
export const JSON_ATTEMPTS = 3;

/**
 * One JSON call through the chain. An answer that is not a JSON object is
 * retried on the next rung (skipping the ones that produced bad answers), up
 * to JSON_ATTEMPTS rungs in all. Returns value null when every answer was
 * unparseable, so callers decide.
 */
export async function chatJson(registry: Registry, call: JsonCall, ledger: Ledger, ctx: Ctx): Promise<JsonAnswer> {
  const chain = withJson(call.chain);
  let skip = chain.skip ?? [];
  let last: JsonAnswer | null = null;
  let salvaged: JsonAnswer | null = null;
  for (let attempt = 0; attempt < JSON_ATTEMPTS; attempt++) {
    let res: Awaited<ReturnType<typeof chat>> | undefined;
    for (let wait = 0; !res; wait++) {
      try {
        res = await chat(
          registry,
          { messages: call.messages, json: true, temperature: 0.2, maxTokens: call.maxTokens ?? DEFAULT_OUTPUT_TOKENS },
          { ...chain, skip },
          ctx,
        );
      } catch (err) {
        const attempts = attemptsOf(err);
        ledger.attempts.push(...attempts);
        if (wait < ledger.rateLimitRetries && onlyRateLimited(attempts) && !ctx.signal?.aborted) {
          ctx.log.warn('every LLM rung is rate-limited, waiting before retrying', {
            step: call.step,
            waitSec: RATE_LIMIT_WAIT_MS / 1000,
            retry: wait + 1,
          });
          await ledger.sleep(RATE_LIMIT_WAIT_MS, ctx.signal);
          continue;
        }
        if (last) return salvageOr(last, salvaged, call, ledger);
        throw err;
      }
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
    const partial = salvageTruncatedJson(res.text);
    if (partial && (!salvaged || res.text.length > salvaged.text.length))
      salvaged = { value: partial, text: res.text, rung: res.rung };
    skip = [...skip, res.rung];
  }
  return salvageOr(last as JsonAnswer, salvaged, call, ledger);
}

/**
 * When no rung returned a whole JSON object, fall back to the longest answer
 * whose complete part could be recovered (cut off at an output limit), and
 * say so in the notes. Claims from it still go through verification.
 */
function salvageOr(last: JsonAnswer, salvaged: JsonAnswer | null, call: JsonCall, ledger: Ledger): JsonAnswer {
  if (last.value || !salvaged) return last;
  ledger.notes.push(
    `The ${call.step} answer from ${salvaged.rung} was cut off before its end; only the items it finished were kept.`,
  );
  return salvaged;
}
