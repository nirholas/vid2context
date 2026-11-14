/**
 * Provider contracts. A provider package default-exports one Provider or an
 * array of them. scripts/gen-registry.mjs discovers provider packages under
 * providers/* and wires them into @vid2context/registry, so adding a provider
 * never requires editing a shared file.
 *
 * Kinds:
 *   source    resolves inputs to VideoRefs, fetches metadata, lists playlists, supplies audio
 *   captions  fetches existing transcripts (creator or platform captions, native transcripts)
 *   stt       contributes speech-to-text rungs
 *   llm       contributes chat-completion rungs
 *   embed     contributes embedding rungs
 *   video     contributes rungs that read a whole video (multimodal models)
 *   visual    contributes rungs that read frames (OCR, vision models)
 *   storage   creates a Storage backend
 */

import type { Storage } from './storage.ts';
import type {
  Attempt,
  AudioInput,
  Comment,
  Ctx,
  Env,
  Policy,
  Runtime,
  Segment,
  Tier,
  Transcript,
  VideoMetadata,
  VideoRef,
  VisualNote,
} from './types.ts';

export type ProviderKind = 'source' | 'captions' | 'stt' | 'llm' | 'embed' | 'video' | 'visual' | 'storage';

interface ProviderBase {
  /** Unique, kebab-case: 'youtube', 'stt-openai-compatible'. */
  id: string;
  kind: ProviderKind;
  /** Human name for UIs and health output. */
  name: string;
  runtimes: Runtime[];
}

// ---------------------------------------------------------------- sources

export interface SourceProvider extends ProviderBase {
  kind: 'source';
  /** True for providers that accept almost any URL (yt-dlp, web page discovery). They are tried after platform-specific sources. */
  catchAll?: boolean;
  /** Return a ref when this provider understands the input, else null. Must be synchronous and cheap (no network). */
  match(input: string): VideoRef | null;
  getMetadata(ref: VideoRef, ctx: Ctx): Promise<VideoMetadata>;
  /** Expand a playlist/channel/feed/page ref into video refs. */
  listItems?(ref: VideoRef, ctx: Ctx, opts?: { limit?: number }): AsyncIterable<VideoRef>;
  /** Whether this provider can supply audio for a ref, possibly from another platform (yt-dlp handles most). */
  canProvideAudio?(ref: VideoRef, ctx: Ctx): boolean;
  getAudio?(ref: VideoRef, ctx: Ctx): Promise<AudioInput>;
  getComments?(ref: VideoRef, ctx: Ctx, opts?: { limit?: number }): Promise<Comment[]>;
}

// ---------------------------------------------------------------- captions

export interface CaptionOptions {
  /** Preferred BCP-47 language. Omit for the spoken language. */
  language?: string;
  /** Allow platform auto-generated captions. Default true. */
  allowAuto?: boolean;
  /** Allow platform machine translation into `language`. Default true. */
  allowTranslated?: boolean;
}

export interface CaptionTrackInfo {
  language: string;
  name: string;
  origin: 'creator-captions' | 'auto-captions' | 'native-transcript';
  translatable?: boolean;
}

export interface CaptionsProvider extends ProviderBase {
  kind: 'captions';
  supports(ref: VideoRef): boolean;
  listTracks?(ref: VideoRef, ctx: Ctx): Promise<CaptionTrackInfo[]>;
  /** Resolve the best track for the options, or null when the video has none. Throw only on real failures. */
  getCaptions(ref: VideoRef, opts: CaptionOptions, ctx: Ctx): Promise<Transcript | null>;
}

// ---------------------------------------------------------------- rungs

/**
 * One candidate in a free-first fallback chain: a specific provider + model +
 * credential. Groq and Cerebras meter quota per model, so each model is its
 * own rung. Rungs are ordered by policy, then tried until one succeeds.
 */
export interface Rung {
  /**
   * Unique and stable: '<kind>/<service>/<model>', e.g. 'llm/groq/openai/gpt-oss-120b'.
   * A pooled extra key adds '#n' to the service: 'llm/groq#2/openai/gpt-oss-120b'.
   * Cooldowns are keyed by this id.
   */
  id: string;
  provider: string;
  /** Upstream service name for health output: 'groq', 'ovh', 'ollama'. */
  service: string;
  model: string;
  tier: Tier;
  /** Lower runs first within a tier. */
  priority: number;
  /** 1 (rough) to 5 (best). Used by the 'quality' policy. */
  quality: number;
  /** Feature flags: 'json', 'tools', 'vision', 'segments', 'diarization', 'words', 'translate', ... */
  capabilities: string[];
  /** Env vars that must be set for the rung to be enabled. Empty for keyless and local rungs. */
  requires: string[];
  /** Synchronous check from env only (no network). Default: every `requires` var is set. */
  isEnabled?(env: Env): boolean;
}

export interface SttOptions {
  language?: string;
  /** Text that biases recognition (names, jargon). */
  prompt?: string;
  diarize?: boolean;
}

export interface SttResult {
  language: string;
  segments: Segment[];
  model: string;
}

export interface SttRung extends Rung {
  /** Largest upload in bytes the rung accepts; larger audio must be split first. */
  maxBytes?: number;
  transcribe(audio: AudioInput, opts: SttOptions, ctx: Ctx): Promise<SttResult>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object; with a schema when the rung supports structured output. */
  json?: boolean | { schema: Record<string, unknown>; name?: string };
}

export interface ChatResult {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmRung extends Rung {
  /** Context window in tokens. */
  contextTokens?: number;
  chat(req: ChatRequest, ctx: Ctx): Promise<ChatResult>;
}

export interface EmbedRung extends Rung {
  dimensions: number;
  embed(texts: string[], ctx: Ctx): Promise<number[][]>;
}

export interface VideoUnderstandingResult {
  transcript?: Transcript;
  visual: VisualNote[];
  model: string;
}

export interface VideoRung extends Rung {
  supports(ref: VideoRef): boolean;
  understand(ref: VideoRef, opts: { language?: string; focus?: string }, ctx: Ctx): Promise<VideoUnderstandingResult>;
}

export interface VisualRung extends Rung {
  /** Read one frame (PNG/JPEG bytes). */
  read(frame: { data: Uint8Array; mimeType: string; atSec: number }, ctx: Ctx): Promise<VisualNote[]>;
}

/**
 * Rung providers build their rungs from env on every call (cheap, no network),
 * so `<PROVIDER>_MODEL` overrides and `<PROVIDER>_FALLBACK_KEYS` pools take
 * effect without code changes. Return every rung the provider knows, enabled
 * or not, so health output can show what a key would unlock.
 */
export interface SttProvider extends ProviderBase {
  kind: 'stt';
  rungs(env: Env): SttRung[];
}
export interface LlmProvider extends ProviderBase {
  kind: 'llm';
  rungs(env: Env): LlmRung[];
}
export interface EmbedProvider extends ProviderBase {
  kind: 'embed';
  rungs(env: Env): EmbedRung[];
}
export interface VideoProvider extends ProviderBase {
  kind: 'video';
  rungs(env: Env): VideoRung[];
}
export interface VisualProvider extends ProviderBase {
  kind: 'visual';
  rungs(env: Env): VisualRung[];
}

// ---------------------------------------------------------------- storage

export interface StorageProvider extends ProviderBase {
  kind: 'storage';
  /** Lower wins when several are enabled. */
  priority: number;
  isEnabled(env: Env): boolean;
  create(ctx: Ctx): Promise<Storage>;
}

export type Provider =
  | SourceProvider
  | CaptionsProvider
  | SttProvider
  | LlmProvider
  | EmbedProvider
  | VideoProvider
  | VisualProvider
  | StorageProvider;

/** Identity helper that type-checks a provider definition. */
export function defineProvider<P extends Provider>(p: P): P {
  return p;
}

export interface ChainOptions {
  policy?: Policy;
  /** Default true. Paid rungs only ever run when their key is set. */
  allowPaid?: boolean;
  /** Restrict to these rung ids, services or providers. */
  only?: string[];
  /** Drop these rung ids, services or providers. */
  skip?: string[];
  /** Required capabilities, e.g. ['json'] or ['vision']. */
  needs?: string[];
  /** Max rungs tried. Default 8. */
  maxAttempts?: number;
}

export type { Attempt };
