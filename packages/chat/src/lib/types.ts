/**
 * Wire types the chat workspace speaks, from docs/prompts/SHARED-CONTRACTS.md
 * section 3 (ModelInfo, ChatApiRequest, the chat SSE events) and
 * docs/contracts/http-api.md (Citation, the error body), plus the records the
 * workspace keeps in IndexedDB.
 */
import type { Attempt, Tier } from '@vid2context/core';

export type ModelKind = 'llm' | 'stt' | 'embed' | 'video' | 'visual';

export interface ModelInfo {
  /** Rung id. Pass it back as ChatApiRequest.model.rung. */
  id: string;
  kind: ModelKind;
  /** Display name: the model id without vendor prefixes, e.g. "gpt-oss-120b". */
  label: string;
  /** Upstream service: 'groq', 'ovh', 'ollama', 'anthropic'. Pooled keys look like 'groq#2'. */
  service: string;
  provider: string;
  model: string;
  tier: Tier;
  quality: number;
  /** Rung capabilities plus 'stream' when the rung streams natively. */
  capabilities: string[];
  contextTokens?: number;
  enabled: boolean;
  /** Env var NAMES the rung needs. Never values. */
  requires: string[];
}

/** A ModelInfo as the picker shows it: with the reason it cannot be chosen, when it cannot. */
export interface ModelRow extends ModelInfo {
  disabledReason?: string;
}

export type ChatModelSpec = { rung: string; strict?: boolean } | { policy: 'free' | 'quality' | 'local-only' };

export interface ChatApiRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Omit for Auto (the server's policy, free-first). */
  model?: ChatModelSpec;
  context?: { inputs?: string[]; collectionId?: string };
  maxTokens?: number;
  temperature?: number;
}

/** One numbered source the answer can cite as [n]. */
export interface ChatSource {
  n: number;
  videoId: string;
  title: string;
  url?: string;
  startSec: number;
  endSec: number;
}

export interface Citation {
  /** The [n] this citation backs (additive field from prompt 34). */
  n?: number;
  videoId: string;
  title: string;
  startSec: number;
  endSec?: number;
  url?: string;
  quote?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatErrorData {
  code: string;
  message: string;
  hint?: string;
  attempts?: Attempt[];
}

export type ChatEvent =
  | {
      type: 'meta';
      rung: string;
      model: string;
      contextTokens?: number;
      sources: ChatSource[];
      /** Estimated tokens of the prompt sent (prompt 34). */
      promptTokens?: number;
      /** A repeat meta after a rung failed mid-answer: drop the partial text and reasoning, start over (prompt 34). */
      restart?: boolean;
    }
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      text: string;
      rung: string;
      model: string;
      usage?: Usage;
      citations: Citation[];
      attempts: Attempt[];
      /** Cited numbers that matched no source; already removed from the text (prompt 34). */
      unverified?: number[];
    }
  | ({ type: 'error' } & ChatErrorData);

/** What the user chose in the model picker. */
export type ModelChoice = { kind: 'auto' } | { kind: 'rung'; rung: string; label: string };

export type ContextKind = 'input' | 'collection' | 'upload' | 'local';

/** A video, collection or upload attached to a conversation. Stores references, not transcripts. */
export interface AttachedContext {
  /** Stable key: the input string, `collection:<id>`, `upload:<sha256>` or the local video id. */
  key: string;
  kind: ContextKind;
  /** What goes into ChatApiRequest.context.inputs (kind input, upload). */
  input?: string;
  collectionId?: string;
  /** Video id (`youtube:abc`) once known. Local contexts are stored under it. */
  videoId?: string;
  title: string;
  thumbnailUrl?: string;
  /** Estimated tokens of the transcript and metadata. */
  tokens?: number;
  /** True when `tokens` comes from duration (about 12k tokens per hour of speech), not a transcript. */
  tokensApprox?: boolean;
  /** Number of videos, for collections. */
  videoCount?: number;
  status: 'loading' | 'ready' | 'error';
  error?: ChatErrorData;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  model: ModelChoice;
  strict: boolean;
  contexts: AttachedContext[];
  /** Start of the last message, for search. */
  preview?: string;
}

export type MessageStatus = 'streaming' | 'done' | 'error' | 'stopped';

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  status: MessageStatus;
  reasoning?: string;
  /** Rung that answered and the upstream model name. */
  rung?: string;
  model?: string;
  /** What the user asked for when this answer was produced, to show fallbacks. */
  requested?: ModelChoice;
  sources?: ChatSource[];
  citations?: Citation[];
  attempts?: Attempt[];
  usage?: Usage;
  promptTokens?: number;
  unverified?: number[];
  error?: ChatErrorData;
}
