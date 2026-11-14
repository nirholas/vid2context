/**
 * Client-only chat: the browser does what POST /api/v1/chat does on the
 * server, with the user's own keys and no vid2context server in between.
 * It grounds the conversation in the attached videos (numbered excerpts that
 * become meta.sources), then streams through core's chatStream, which ranks
 * rungs free-first (or starts with the one the user picked), falls back
 * before the first answer token, shares the chain's cooldowns and records
 * every attempt. Services whose API blocks browser requests are skipped.
 * Events match the server's: meta, reasoning, delta, then done or error.
 */
import {
  attemptsOf,
  type Attempt,
  type ChatMessage,
  chatStream,
  type Ctx,
  estimateTokens,
  type LlmRung,
  rankRungs,
  type Registry,
  resolveModelChoice,
  type StreamChainOptions,
  type VideoContext,
  Vid2ContextError,
} from '@vid2context/core';
import { toErrorData } from './api.ts';
import { citationsFromText } from './citations.ts';
import { browserCorsFor } from './cors.ts';
import { buildGrounding } from './sources.ts';
import type { ChatApiRequest, ChatEvent } from './types.ts';

/** Window assumed for rungs that do not declare one. */
export const DEFAULT_CONTEXT_TOKENS = 8192;
const ANSWER_TOKENS = 4096;
/** How many ranked rungs the grounding budget must fit, so a fallback does not overflow. */
const BUDGET_LOOKAHEAD = 3;

export interface LocalChatOptions {
  registry: Pick<Registry, 'llmRungs'>;
  ctx: Ctx;
  request: ChatApiRequest;
  contexts: VideoContext[];
}

/** Rung ids the browser cannot call (CORS), passed to the chain as `skip`. */
export function blockedRungIds(rungs: LlmRung[]): string[] {
  return rungs.filter((r) => browserCorsFor(r.service, r.provider, r.tier).status === 'blocked').map((r) => r.id);
}

/** Chain options for the request's model choice, minus what the browser cannot call. */
export function chainOptions(registry: Pick<Registry, 'llmRungs'>, request: ChatApiRequest, ctx: Ctx): StreamChainOptions {
  const rungs = registry.llmRungs(ctx.env);
  const blocked = blockedRungIds(rungs);
  const spec = request.model;
  if (spec && 'rung' in spec && blocked.includes(spec.rung)) {
    const r = rungs.find((x) => x.id === spec.rung);
    throw new Vid2ContextError('bad-request', `${spec.rung} cannot be called from a web page.`, {
      hint: `${browserCorsFor(r?.service ?? '', r?.provider, r?.tier).reason ?? ''} Or pick another model.`.trim(),
    });
  }
  const base = resolveModelChoice(spec, registry as Registry, ctx.env);
  return { ...base, skip: [...(base.skip ?? []), ...blocked] };
}

/** The smallest window among the rungs likely to answer, so the grounding fits whichever one does. */
export function groundingWindow(registry: Pick<Registry, 'llmRungs'>, opts: StreamChainOptions, ctx: Ctx): number {
  const rungs = registry.llmRungs(ctx.env);
  const ranked = rankRungs(rungs, opts, ctx.env);
  const preferred = ranked.filter((r) => opts.prefer?.includes(r.id));
  const order = [...preferred, ...ranked.filter((r) => !preferred.includes(r))].slice(0, BUDGET_LOOKAHEAD);
  if (order.length === 0) return DEFAULT_CONTEXT_TOKENS;
  return Math.min(...order.map((r) => r.contextTokens ?? DEFAULT_CONTEXT_TOKENS));
}

export async function* localChat(opts: LocalChatOptions): AsyncGenerator<ChatEvent> {
  const { ctx, request, registry } = opts;
  let chain: StreamChainOptions;
  try {
    chain = chainOptions(registry, request, ctx);
  } catch (err) {
    yield { type: 'error', ...toErrorData(err) };
    return;
  }

  const history: ChatMessage[] = request.messages.map((m) => ({ role: m.role, content: m.content }));
  const historyTokens = history.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
  const window = groundingWindow(registry, chain, ctx);
  const answerTokens = Math.min(request.maxTokens ?? ANSWER_TOKENS, Math.floor(window / 4));
  const grounding = buildGrounding(opts.contexts, Math.max(512, window - historyTokens - answerTokens - 256));
  const messages: ChatMessage[] = grounding.system ? [{ role: 'system', content: grounding.system }, ...history] : history;
  const promptTokens = historyTokens + grounding.tokens;

  let text = '';
  try {
    for await (const ev of chatStream(
      registry as Registry,
      { messages, maxTokens: answerTokens, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) },
      chain,
      ctx,
    )) {
      if (ev.type === 'meta') {
        if (ev.restart) text = '';
        yield {
          type: 'meta',
          rung: ev.rung,
          model: ev.model,
          ...(ev.contextTokens !== undefined ? { contextTokens: ev.contextTokens } : {}),
          sources: grounding.sources,
          promptTokens,
          ...(ev.restart ? { restart: true } : {}),
        };
      } else if (ev.type === 'delta') {
        text += ev.text;
        yield ev;
      } else if (ev.type === 'reasoning') {
        yield ev;
      } else {
        const finalText = ev.result.text || text;
        yield {
          type: 'done',
          text: finalText,
          rung: ev.rung,
          model: ev.result.model,
          ...(ev.result.usage ? { usage: ev.result.usage } : {}),
          citations: citationsFromText(finalText, grounding.sources),
          attempts: ev.attempts,
        };
        return;
      }
    }
  } catch (err) {
    if (ctx.signal?.aborted) return;
    const attempts: Attempt[] = attemptsOf(err);
    const data = toErrorData(err);
    yield { type: 'error', ...data, ...(attempts.length ? { attempts } : {}), ...hintFor(data.code, data.hint) };
  }
}

function hintFor(code: string, hint: string | undefined): { hint?: string } {
  if (code === 'no-provider') {
    return { hint: 'No model can answer from this browser. Add a free key (Groq, Mistral or Gemini) in Settings, or allow keyless models.' };
  }
  if (code === 'all-rungs-failed') {
    return {
      hint: 'Each attempt below says why. Keyless models are rate-limited per IP; a free Groq, Mistral or Gemini key in Settings adds more models.',
    };
  }
  return hint ? { hint } : {};
}
