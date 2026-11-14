/**
 * Shared data model for vid2context. Every provider, surface and storage
 * backend speaks these types. Changing a field here is a contract change:
 * update docs/contracts/ and every consumer in the same commit.
 */

/** Where code is running. Providers declare which runtimes they support. */
export type Runtime = 'node' | 'workers' | 'browser';

/** A string-keyed environment: process.env on Node, bindings on Workers, user settings in the browser. */
export type Env = Record<string, string | undefined>;

/** What kind of thing an input points at. */
export type RefKind = 'video' | 'playlist' | 'channel' | 'feed' | 'page';

/** A resolved, canonical pointer to a piece of media or a list of media. */
export interface VideoRef {
  /** The raw input the user gave (URL, path, id). */
  input: string;
  /** Platform slug: 'youtube', 'vimeo', 'file', 'podcast', 'web', ... */
  platform: string;
  kind: RefKind;
  /** Stable, globally unique id: `${platform}:${nativeId}`. Used as the cache and storage key. */
  id: string;
  /** The platform's own id (YouTube video id, file hash, episode guid). */
  nativeId: string;
  /** Canonical URL when one exists. */
  url?: string;
}

export interface Chapter {
  title: string;
  startSec: number;
  endSec?: number;
}

export interface VideoMetadata {
  ref: VideoRef;
  title: string;
  channel?: { name: string; id?: string; url?: string };
  description?: string;
  durationSec?: number;
  /** ISO 8601. */
  publishedAt?: string;
  thumbnailUrl?: string;
  /** BCP-47 language of the spoken audio when known. */
  language?: string;
  tags?: string[];
  chapters: Chapter[];
  isLive?: boolean;
  /** Provider-specific extras that do not deserve a first-class field. */
  extra?: Record<string, unknown>;
}

/** One timed piece of transcript text. */
export interface Segment {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
  /** 0..1 when the producer reports it. */
  confidence?: number;
}

/**
 * How a transcript was produced, from most to least trustworthy:
 * creator-captions (uploaded by the creator), auto-captions (platform ASR),
 * stt (our speech-to-text), video-model (a multimodal model watched the video),
 * native-transcript (a transcript the platform publishes, e.g. podcast:transcript).
 */
export type TranscriptOrigin = 'creator-captions' | 'auto-captions' | 'native-transcript' | 'stt' | 'video-model';

export interface Transcript {
  ref: VideoRef;
  /** BCP-47 language of the text. */
  language: string;
  origin: TranscriptOrigin;
  /** Id of the provider or rung that produced it. */
  producer: string;
  model?: string;
  /** True when the text was machine-translated from another language. */
  translated?: boolean;
  segments: Segment[];
  /** ISO 8601. */
  createdAt: string;
}

/** Something seen on screen at a moment in the video (slide text, code, a chart, a caption burned into the frame). */
export interface VisualNote {
  atSec: number;
  kind: 'ocr' | 'description' | 'slide' | 'code' | 'chart';
  text: string;
  producer: string;
}

export interface Comment {
  id: string;
  author: string;
  text: string;
  likes?: number;
  /** ISO 8601 when known. */
  publishedAt?: string;
  isCreator?: boolean;
  isPinned?: boolean;
  replies?: Comment[];
}

/** Everything vid2context knows about one video. This is what agents receive. */
export interface VideoContext {
  metadata: VideoMetadata;
  transcript: Transcript;
  visual?: VisualNote[];
  comments?: Comment[];
  /** How the transcript was obtained: every provider/rung tried, in order. */
  attempts: Attempt[];
}

/** Audio handed to a speech-to-text rung. */
export type AudioInput =
  | {
      kind: 'bytes';
      data: Uint8Array;
      mimeType: string;
      filename: string;
      durationSec?: number;
    }
  | {
      kind: 'url';
      url: string;
      mimeType?: string;
      durationSec?: number;
    };

/**
 * Cost tier, in default preference order:
 * local    runs on this machine; free and private.
 * free     hosted free tier that needs your own key (Groq, Gemini AI Studio, Cerebras, ...).
 * keyless  hosted and free with no key at all (zero-config safety net).
 * paid     costs money per call.
 */
export type Tier = 'local' | 'free' | 'keyless' | 'paid';

/**
 * How to order rungs.
 * free        local, then free, then keyless, then paid (default).
 * local-only  only local rungs; nothing leaves the machine.
 * quality     highest quality score first, tier as tie-breaker.
 */
export type Policy = 'free' | 'local-only' | 'quality';

export interface Attempt {
  /** Rung or provider id. */
  id: string;
  stage: 'resolve' | 'metadata' | 'captions' | 'audio' | 'stt' | 'video' | 'llm' | 'embed' | 'visual';
  outcome: 'ok' | 'skipped' | 'empty' | 'error';
  /** Short machine-readable reason: 'no-key', 'cooldown', 'rate-limited', 'too-large', 'http-500', ... */
  reason?: string;
  detail?: string;
  ms?: number;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Passed to every provider call. Never reach for globals (process.env, fetch) directly: use this. */
export interface Ctx {
  env: Env;
  runtime: Runtime;
  fetch: typeof fetch;
  log: Logger;
  signal?: AbortSignal;
}
