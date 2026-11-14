/**
 * Pieces shared by the Anthropic and Gemini clients: the extended usage and
 * result types, model lists from env, and reading wait times from responses.
 */
import type { ChatResult, Env } from '@vid2context/core';

/**
 * ChatResult.usage plus the cache and reasoning counters the native APIs
 * report. Core's type has only input and output tokens, so these fields are
 * added on the result object without changing core.
 */
export interface NativeUsage {
  /** Uncached input tokens billed at the full rate. */
  inputTokens?: number;
  outputTokens?: number;
  /** Anthropic: tokens written to the prompt cache on this call (billed at about 1.25x). */
  cacheCreationInputTokens?: number;
  /** Tokens served from a cache (Anthropic cache reads, Gemini implicit cache hits), billed at about 0.1x. */
  cacheReadInputTokens?: number;
  /** Gemini: tokens the model spent thinking. */
  reasoningTokens?: number;
}

export interface NativeChatResult extends ChatResult {
  usage?: NativeUsage;
  /** Why generation stopped, as the upstream named it ('end_turn', 'max_tokens', 'STOP'). */
  stopReason?: string;
}

export interface ModelDef {
  id: string;
  quality: number;
  contextTokens?: number;
}

/** A comma-separated model list from env replaces the defaults; unknown ids get quality 3. */
export function modelsFromEnv(env: Env, modelVar: string, defaults: ModelDef[]): ModelDef[] {
  const ids = (env[modelVar] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return defaults;
  return ids.map((id) => defaults.find((m) => m.id === id) ?? { id, quality: 3 });
}

/** Strip trailing slashes from a base URL. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Seconds until an RFC 3339 timestamp, or undefined when it is missing, unparsable or past. */
export function secondsUntil(iso: string | null | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const sec = Math.ceil((t - now) / 1000);
  return sec > 0 ? sec : undefined;
}

/** Parse a JSON body without throwing. */
export function tryJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
