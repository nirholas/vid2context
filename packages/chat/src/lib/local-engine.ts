/**
 * Client-only chat: the browser does what POST /api/v1/chat does on the
 * server, with the user's own keys and no vid2context server in between.
 * It ranks the browser registry's LLM rungs free-first (or starts with the
 * rung the user picked), grounds the conversation in the attached videos,
 * streams from the first rung that answers, and emits the same events as the
 * server (meta, reasoning, delta, done or error) with every attempt recorded.
 */
import {
  type Attempt,
  type ChatMessage,
  type ChatStreamEvent,
  type Ctx,
  estimateTokens,
  isInputError,
  type LlmRung,
  rankRungs,
  streamFromRung,
  type VideoContext,
  Vid2ContextError,
} from '@vid2context/core';
import { citationsFromText } from './citations.ts';
import { browserCorsFor } from './cors.ts';
import { buildGrounding } from './sources.ts';
import type { ChatApiRequest, ChatEvent } from './types.ts';

/** Window assumed for rungs that do not declare one. */
export const DEFAULT_CONTEXT_TOKENS = 8192;
const ANSWER_TOKENS = 4096;
const MAX_ATTEMPTS = 6;

export interface LocalChatOptions {
  rungs: LlmRung[];
  ctx: Ctx;
  request: ChatApiRequest;
  contexts: VideoContext[];
}

/** Rungs the browser can call: CORS allows it, or the rung runs inside the page. */
export function browserCallable(rungs: LlmRung[]): LlmRung[] {
  return rungs.filter((r) => browserCorsFor(r.service, r.provider).status !== 'blocked');
}

/** The rungs to try, in order, for the request's model choice. */
export function planRungs(rungs: LlmRung[], request: ChatApiRequest, ctx: Ctx): LlmRung[] {
  const callable = browserCallable(rungs);
  const spec = request.model;
  if (spec && 'rung' in spec) {
    const picked = callable.find((r) => r.id === spec.rung);
    const rankedPick = picked ? rankRungs([picked], { maxAttempts: 1 }, ctx.env) : [];
    if (spec.strict) return rankedPick;
    const rest = rankRungs(
      callable.filter((r) => r.id !== spec.rung),
      {},
      ctx.env,
    );
    return [...rankedPick, ...rest];
  }
  const policy = spec && 'policy' in spec ? spec.policy : undefined;
  return rankRungs(callable, policy ? { policy } : {}, ctx.env);
}

function reasonFor(err: unknown): string {
  if (err instanceof Vid2ContextError) return err.status ? `${err.code}-${err.status}` : err.code;
  if (err instanceof Error && err.name === 'AbortError') return 'aborted';
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  if (err instanceof TypeError) return 'network';
  return 'error';
}

function detailOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof TypeError) return `${msg} (the browser could not reach the service; CORS or network)`;
  return msg.slice(0, 300);
}

function isAbort(err: unknown, ctx: Ctx): boolean {
  return Boolean(ctx.signal?.aborted) || (err instanceof Error && err.name === 'AbortError');
}

export async function* localChat(opts: LocalChatOptions): AsyncGenerator<ChatEvent> {
  const { ctx, request } = opts;
  const plan = planRungs(opts.rungs, request, ctx);
  const attempts: Attempt[] = [];

  if (plan.length === 0) {
    const spec = request.model;
    const strictPick = spec && 'rung' in spec && spec.strict;
    yield {
      type: 'error',
      code: 'no-provider',
      message: strictPick ? `The model ${spec.rung} is not available in this browser.` : 'No model can answer from this browser.',
      hint: strictPick
        ? 'Turn off Strict to let another model answer, or add the key it needs in Settings.'
        : 'Add a free key (Groq, Mistral or Gemini) in Settings, or allow keyless models.',
      attempts,
    };
    return;
  }

  const history: ChatMessage[] = request.messages.map((m) => ({ role: m.role, content: m.content }));
  const historyTokens = history.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);

  let tried = 0;
  for (const rung of plan) {
    if (tried >= MAX_ATTEMPTS || ctx.signal?.aborted) break;
    tried++;
    const window = rung.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
    const answerTokens = Math.min(request.maxTokens ?? ANSWER_TOKENS, Math.floor(window / 4));
    const grounding = buildGrounding(opts.contexts, Math.max(512, window - historyTokens - answerTokens - 256));
    const messages: ChatMessage[] = grounding.system ? [{ role: 'system', content: grounding.system }, ...history] : history;
    const started = Date.now();
    const iterator = streamFromRung(
      rung,
      { messages, maxTokens: answerTokens, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) },
      ctx,
    )[Symbol.asyncIterator]();

    let first: IteratorResult<ChatStreamEvent>;
    try {
      first = await iterator.next();
    } catch (err) {
      if (isAbort(err, ctx)) return;
      attempts.push({ id: rung.id, stage: 'llm', outcome: 'error', reason: reasonFor(err), detail: detailOf(err), ms: Date.now() - started });
      if (isInputError(err)) break;
      continue;
    }

    yield {
      type: 'meta',
      rung: rung.id,
      model: rung.model,
      ...(rung.contextTokens ? { contextTokens: rung.contextTokens } : {}),
      sources: grounding.sources,
    };

    let text = '';
    try {
      let step = first;
      while (!step.done) {
        const ev = step.value;
        if (ev.type === 'delta') {
          text += ev.text;
          yield { type: 'delta', text: ev.text };
        } else if (ev.type === 'reasoning') {
          yield { type: 'reasoning', text: ev.text };
        } else {
          attempts.push({ id: rung.id, stage: 'llm', outcome: 'ok', ms: Date.now() - started });
          const finalText = ev.result.text || text;
          yield {
            type: 'done',
            text: finalText,
            rung: rung.id,
            model: ev.result.model || rung.model,
            ...(ev.result.usage ? { usage: ev.result.usage } : {}),
            citations: citationsFromText(finalText, grounding.sources),
            attempts,
          };
          return;
        }
        step = await iterator.next();
      }
      throw new Vid2ContextError('upstream', `${rung.id}: the stream ended without a final result.`);
    } catch (err) {
      if (isAbort(err, ctx)) return;
      // Part of an answer was already shown, so falling back would mix two answers: report instead.
      attempts.push({ id: rung.id, stage: 'llm', outcome: 'error', reason: reasonFor(err), detail: detailOf(err), ms: Date.now() - started });
      yield {
        type: 'error',
        code: err instanceof Vid2ContextError ? err.code : 'upstream',
        message: `The answer from ${rung.id} broke off: ${detailOf(err)}`,
        hint: 'Retry, or pick another model.',
        attempts,
      };
      return;
    }
  }

  if (ctx.signal?.aborted) return;
  yield {
    type: 'error',
    code: 'all-rungs-failed',
    message: `Every model tried failed (${attempts.length} tried).`,
    hint: 'Each attempt below says why. Keyless models are rate-limited per IP; adding a free Groq, Mistral or Gemini key in Settings adds more.',
    attempts,
  };
}
