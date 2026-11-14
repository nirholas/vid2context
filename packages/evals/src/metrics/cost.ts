/**
 * Cost of a run. Local, free-tier and keyless rungs cost nothing. Paid rungs
 * are priced from the table below, which lists only vendor-published list
 * prices; a paid rung missing from it is reported as unpriced (null) rather
 * than guessed. Re-check the vendor page before quoting a cost.
 *
 *   stt/openai/whisper-1   USD 0.006 per audio minute (OpenAI's published whisper-1 price)
 */
import type { Tier } from '@vid2context/core';

export interface Price {
  /** USD per minute of audio. */
  perAudioMinute?: number;
  /** USD per million input tokens. */
  perMillionInput?: number;
  /** USD per million output tokens. */
  perMillionOutput?: number;
}

/** Keyed by rung id without the pooled-key suffix ('stt/openai#2/whisper-1' prices as 'stt/openai/whisper-1'). */
export const PRICES: Record<string, Price> = {
  'stt/openai/whisper-1': { perAudioMinute: 0.006 },
};

export interface Usage {
  audioSec?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Strip the '#n' pooled-key suffix from the service part of a rung id. */
export function priceKey(rungId: string): string {
  return rungId.replace(/^([^/]+\/[^/#]+)#\d+/, '$1');
}

/** USD for one call, 0 for non-paid tiers, null when a paid rung has no listed price. */
export function costOf(rungId: string, tier: Tier, usage: Usage, prices: Record<string, Price> = PRICES): number | null {
  if (tier !== 'paid') return 0;
  const p = prices[priceKey(rungId)];
  if (!p) return null;
  let usd = 0;
  if (p.perAudioMinute !== undefined) usd += ((usage.audioSec ?? 0) / 60) * p.perAudioMinute;
  if (p.perMillionInput !== undefined) usd += ((usage.inputTokens ?? 0) / 1e6) * p.perMillionInput;
  if (p.perMillionOutput !== undefined) usd += ((usage.outputTokens ?? 0) / 1e6) * p.perMillionOutput;
  return usd;
}
