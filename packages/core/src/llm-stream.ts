/**
 * Optional streaming for LLM rungs. A rung that can stream implements
 * StreamingLlmRung. Callers use streamFromRung(), which streams natively when
 * the rung supports it and otherwise calls chat() and emits the whole text as
 * one delta, so every rung works behind a streaming UI.
 *
 * Created verbatim from docs/prompts/SHARED-CONTRACTS.md. Change it only
 * additively, and update that file in the same commit.
 */
import type { ChatRequest, ChatResult, LlmRung } from './provider.ts';
import type { Ctx } from './types.ts';

export type ChatStreamEvent =
  /** Visible answer text, in order. */
  | { type: 'delta'; text: string }
  /** Model reasoning text when the upstream exposes it. Never mixed into the answer. */
  | { type: 'reasoning'; text: string }
  /** Exactly one, last: the complete result (full text, model, usage). */
  | { type: 'done'; result: ChatResult };

export interface StreamingLlmRung extends LlmRung {
  stream(req: ChatRequest, ctx: Ctx): AsyncIterable<ChatStreamEvent>;
}

export function canStream(rung: LlmRung): rung is StreamingLlmRung {
  return typeof (rung as Partial<StreamingLlmRung>).stream === 'function';
}

/** Stream from any rung: native streaming when available, otherwise one delta from chat(). */
export async function* streamFromRung(rung: LlmRung, req: ChatRequest, ctx: Ctx): AsyncIterable<ChatStreamEvent> {
  if (canStream(rung)) {
    yield* rung.stream(req, ctx);
    return;
  }
  const result = await rung.chat(req, ctx);
  yield { type: 'delta', text: result.text };
  yield { type: 'done', result };
}
