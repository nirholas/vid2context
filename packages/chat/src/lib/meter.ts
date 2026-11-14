/**
 * Token meter: attached context plus the conversation, against the selected
 * model's context window. Estimates come from estimateTokens in core (a
 * heuristic tuned against real tokenizers), so the meter warns with headroom
 * before a request would overflow, and suggests a larger-context model.
 */
import { estimateTokens } from '@vid2context/core';
import type { AttachedContext, ModelRow } from './types.ts';

/** Room kept for the answer and the system prompt. */
export const ANSWER_RESERVE = 2048;
/** Warn from this share of the window. */
export const WARN_AT = 0.8;

export type MeterLevel = 'ok' | 'warn' | 'over' | 'unknown';

export interface MeterReading {
  contextTokens: number;
  conversationTokens: number;
  used: number;
  /** The model's window, when known. */
  limit?: number;
  ratio?: number;
  level: MeterLevel;
  /** A larger-context enabled model that fits, when the current one is tight or over. */
  suggestion?: ModelRow;
  /** True when some attached item's tokens are a duration-based guess. */
  approx: boolean;
}

export function conversationTokens(messages: { content: string }[]): number {
  // About 4 tokens of role and separator overhead per message.
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export function attachedTokens(contexts: AttachedContext[]): { tokens: number; approx: boolean } {
  let tokens = 0;
  let approx = false;
  for (const c of contexts) {
    if (c.status !== 'ready' || c.tokens === undefined) continue;
    tokens += c.tokens;
    if (c.tokensApprox) approx = true;
  }
  return { tokens, approx };
}

export function readMeter(
  contexts: AttachedContext[],
  messages: { content: string }[],
  model: ModelRow | undefined,
  rows: ModelRow[],
  draft = '',
): MeterReading {
  const att = attachedTokens(contexts);
  const conv = conversationTokens(draft ? [...messages, { content: draft }] : messages);
  const used = att.tokens + conv + (att.tokens + conv > 0 ? ANSWER_RESERVE : 0);
  const limit = model?.contextTokens;
  if (!limit) return { contextTokens: att.tokens, conversationTokens: conv, used, level: 'unknown', approx: att.approx };
  const ratio = used / limit;
  const level: MeterLevel = ratio > 1 ? 'over' : ratio >= WARN_AT ? 'warn' : 'ok';
  const reading: MeterReading = {
    contextTokens: att.tokens,
    conversationTokens: conv,
    used,
    limit,
    ratio,
    level,
    approx: att.approx,
  };
  if (level !== 'ok') {
    const suggestion = suggestLarger(rows, used, limit);
    if (suggestion) reading.suggestion = suggestion;
  }
  return reading;
}

/**
 * The smallest enabled window that holds `used` with the warning headroom,
 * larger than the current one; ties go to the free-first order of `rows`.
 */
export function suggestLarger(rows: ModelRow[], used: number, currentLimit: number): ModelRow | undefined {
  const need = used / WARN_AT;
  let best: ModelRow | undefined;
  for (const r of rows) {
    if (!r.enabled || !r.contextTokens || r.contextTokens <= currentLimit || r.contextTokens < need) continue;
    if (!best || (best.contextTokens ?? 0) > r.contextTokens) best = r;
  }
  return best;
}

/** 1234 -> '1.2K', 987 -> '987', 1048576 -> '1M'. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1000) return `${trim(n / 1000)}K`;
  return String(n);
}

function trim(v: number): string {
  return v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}
