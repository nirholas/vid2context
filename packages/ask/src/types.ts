/**
 * Public types of the ask engine. The event shapes match the `/chat` SSE
 * contract in docs/prompts/SHARED-CONTRACTS.md section 3 field for field;
 * extra fields are additive.
 */
import type { Attempt, ChatMessage, Ctx, Policy, Registry, Storage, VideoContext } from '@vid2context/core';

/** The citation shape from docs/contracts/http-api.md, plus the source number it came from. */
export interface Citation {
  videoId: string;
  title: string;
  startSec: number;
  endSec?: number;
  /** Timestamp link from `timestampUrl`. */
  url?: string;
  /** A short excerpt of the transcript at that moment. */
  quote?: string;
  /** The `[n]` in the answer this citation backs. */
  n: number;
}

/** One numbered piece of transcript the answer may cite as `[n]`. */
export interface Source {
  /** 1..k, matching `[n]` in the answer. */
  n: number;
  videoId: string;
  title: string;
  /** Timestamp link to `startSec`, when the platform has one. */
  url?: string;
  startSec: number;
  endSec: number;
  /** The transcript excerpt, raw caption text. */
  text: string;
}

/** The source list as sent in the `meta` event: everything but the text. */
export type SourceRef = Omit<Source, 'text'>;

/**
 * Which model answers.
 *   { rung }           start with this rung id, then fall back along the chain
 *   { rung, strict }   this rung or an error
 *   { policy }         the chain ordered by that policy
 *   undefined          Auto: the server's policy (free first by default)
 */
export type ModelChoice = { rung: string; strict?: boolean } | { policy: Policy };

/** A previous turn. Only user and assistant turns are accepted. */
export type HistoryMessage = { role: 'user' | 'assistant'; content: string };

export interface AskOptions {
  question: string;
  /** Earlier turns, oldest first, not including `question`. */
  history?: HistoryMessage[];
  /** Ground in these contexts directly. */
  contexts?: VideoContext[];
  /** URLs, ref ids (`youtube:abc`) or `upload:<sha256>`, resolved through getVideoContext with `storage`. */
  inputs?: string[];
  /** A saved collection. */
  collectionId?: string;
  /** Library and cache. Saved contexts are reused; resolved ones are saved; keyword search runs here. */
  storage: Storage;
  model?: ModelChoice;
  /** Most answer tokens. Default 2048 (reasoning models spend part of it thinking). */
  maxTokens?: number;
  /** Default 0.2. */
  temperature?: number;
  /** Cap on the tokens of source text sent, whatever the model window. Default 32000. */
  maxSourceTokens?: number;
  /** Retrieval strategy. Default: `defaultRetriever`. */
  retriever?: Retriever;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface AskResult {
  answer: string;
  /** One per cited source number that exists, in order of first use. */
  citations: Citation[];
  /** `[n]` numbers the model wrote that match no source. They were removed from the answer. */
  unverified: number[];
  sources: Source[];
  rung: string;
  model: string;
  usage?: Usage;
  attempts: Attempt[];
}

export type AskEvent =
  | {
      type: 'meta';
      rung: string;
      model: string;
      /** The answering rung's context window, as in ModelInfo. */
      contextTokens?: number;
      /** Estimated tokens of the prompt sent (instructions, history, sources, question). */
      promptTokens: number;
      sources: SourceRef[];
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
      unverified: number[];
      attempts: Attempt[];
    }
  | { type: 'error'; code: string; message: string; hint?: string; attempts?: Attempt[] };

/** What a retriever searches: the resolved videos and the library they live in. */
export interface RetrievalScope {
  contexts: VideoContext[];
  storage: Storage;
  collectionId?: string;
  /** Most tokens of source text to return. */
  budgetTokens: number;
  registry: Registry;
}

/**
 * The retrieval seam. The default implementation (whole transcripts when they
 * fit, else keyword plus optional vector search fused with RRF) can be
 * replaced by another engine without changing callers.
 */
export interface Retriever {
  /** Return numbered sources (n = 1..k) for the question, within `scope.budgetTokens`. */
  retrieve(question: string, scope: RetrievalScope, ctx: Ctx): Promise<Source[]>;
  /** True when this retriever ignores the question for this scope (every source fits), so no standalone query is needed. */
  needsQuery?(scope: RetrievalScope): boolean;
}

export type { ChatMessage };
