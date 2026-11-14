import type { Attempt, ChainOptions, VideoRef } from '@vid2context/core';

/** A pointer into a video, as in docs/contracts/http-api.md. `url` is a timestamp link from `timestampUrl`. */
export interface Citation {
  videoId: string;
  title: string;
  startSec: number;
  endSec?: number;
  url?: string;
  quote?: string;
}

/** A claim as a model proposes it, before verification. `startSec` may arrive as a number or a "m:ss" string. */
export interface RawClaim {
  claim: string;
  quote: string;
  videoId: string;
  startSec: number | string;
  topic: string;
  stance?: string;
}

/** A claim whose quote was found in the transcript near its timestamp. */
export interface Claim {
  /** Stable within one brief: c1, c2, ... */
  id: string;
  claim: string;
  topic: string;
  stance?: string;
  videoId: string;
  /** The verified citation: startSec snapped to the segment where the quote starts. */
  citation: Citation & { quote: string };
  /** Token overlap between the quote and the transcript, 0..1. */
  score: number;
}

export type UnverifiedReason =
  | 'unknown-video'
  | 'no-quote'
  | 'quote-too-short'
  | 'bad-timestamp'
  | 'quote-at-other-time'
  | 'quote-not-found';

/** A claim that could not be verified. Never shown as cited; listed in the appendix with the reason. */
export interface UnverifiedClaim {
  claim: string;
  quote?: string;
  videoId?: string;
  startSec?: number;
  topic?: string;
  reason: UnverifiedReason;
  /** Human detail: best score, or where the quote really is. */
  detail: string;
  /** For quote-at-other-time: where the quote actually is. */
  foundAtSec?: number;
  /** For extractions: JSON pointer of the citation inside the result. */
  path?: string;
}

export type PointKind = 'consensus' | 'disagreement' | 'single-source';

/** One finding of a brief: a statement, the claims that back it and, for disagreements, the claims against it. */
export interface Point {
  topic: string;
  kind: PointKind;
  statement: string;
  /** For disagreements: the opposing position in one sentence. */
  counter?: string;
  support: Citation[];
  oppose: Citation[];
  /** Distinct video ids among support and oppose. */
  videos: string[];
  /** Claim ids behind support and oppose. */
  claimIds: { support: string[]; oppose: string[] };
}

export interface SourceSummary {
  videoId: string;
  ref: VideoRef;
  title: string;
  channel?: string;
  durationSec?: number;
  publishedAt?: string;
  url?: string;
  origin: string;
  language: string;
}

export type Step = 'single' | 'map' | 'reduce' | 'extract' | 'repair';

/** Which rung served one LLM step. */
export interface RungUse {
  step: Step;
  rung: string;
  model: string;
  /** For map steps: which video and chunk. */
  videoId?: string;
  chunk?: number;
}

export interface Brief {
  question?: string;
  template: string;
  /** How the brief was produced: one pass over every source, or map-reduce. */
  strategy: 'single' | 'map-reduce';
  markdown: string;
  /** Verified claims only. */
  claims: Claim[];
  consensus: Point[];
  disagreements: Point[];
  singleSource: Point[];
  unverified: UnverifiedClaim[];
  sources: SourceSummary[];
  rungs: RungUse[];
  attempts: Attempt[];
  /** Steps that failed or degraded (a map chunk with no answer, a reduce batch that fell back). */
  notes: string[];
  /** ISO 8601. */
  createdAt: string;
}

export interface ExtractionResult {
  template?: string;
  /** The JSON matching the template or schema. Every citation object left inside it was verified and carries `url`. */
  data: unknown;
  /** Verified citations found in `data`, with their JSON pointer. */
  citations: (Citation & { path: string })[];
  unverified: UnverifiedClaim[];
  /** True when the first answer failed validation and the repair call fixed it. */
  repaired: boolean;
  sources: SourceSummary[];
  rungs: RungUse[];
  attempts: Attempt[];
  notes: string[];
  createdAt: string;
}

export interface LlmOptions {
  /** Rung chain options for every step. JSON support is always required. */
  chain?: ChainOptions;
  /** Cap on source tokens per LLM call. Default: from the first ranked rung's context window, at most 24k. */
  maxChunkTokens?: number;
  /** Output tokens per call. Default 4000. */
  maxOutputTokens?: number;
}

export interface BriefOptions extends LlmOptions {
  question?: string;
  /** Template id. Default `brief`. */
  template?: string;
  /** Chain options for the reduce step only. Default: `chain` with policy `quality` unless a policy is set. */
  reduceChain?: ChainOptions;
}
