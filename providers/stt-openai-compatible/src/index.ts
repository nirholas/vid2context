/**
 * Speech-to-text rungs for every OpenAI-compatible /audio/transcriptions API.
 *
 *   local    LOCAL_STT_BASE_URL + LOCAL_STT_MODEL (speaches, faster-whisper-server, LocalAI)
 *   free     Groq whisper-large-v3-turbo (GROQ_API_KEY), then Mistral voxtral-mini-transcribe-3
 *            (MISTRAL_API_KEY, Experiment plan); every key pooled with <PROVIDER>_FALLBACK_KEYS
 *   keyless  OVH AI Endpoints whisper-large-v3-turbo (no account; about 2 requests/minute per IP)
 *   paid     DeepInfra whisper-large-v3-turbo, Together whisper-large-v3, OpenAI whisper-1,
 *            cheapest first
 *
 * Every model id can be overridden with <PROVIDER>_STT_MODEL.
 */
import { defineProvider, type Env, keyPool, pooledService, type SttProvider, type SttRung, type Tier } from '@vid2context/core';
import { type Dialect, type Endpoint, transcribeWith } from './client.ts';

export type { Dialect, Endpoint, Word, WordSegment } from './client.ts';
export {
  DEFAULT_DOWNLOAD_CAP,
  parseVerboseJson,
  sttErrorFromResponse,
  transcribeWith,
  uploadFilename,
  uploadMimeType,
} from './client.ts';
export { normalizeLanguage } from './languages.ts';
export { clampPrompt, type PromptMetadata, promptFromMetadata } from './prompt.ts';
export { parseDuration, retryAfterFromHeaders } from './ratelimit.ts';

const MB = 1024 * 1024;
export const OVH_BASE_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
export const DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai';
export const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';

/**
 * Documented defaults for the generic local rung. Set LOCAL_STT_BASE_URL and
 * LOCAL_STT_MODEL to one of these (docs/guides/speech-to-text.md has the
 * commands that start each server).
 */
export const LOCAL_STT_PRESETS = {
  speaches: { baseUrl: 'http://localhost:8000/v1', model: 'Systran/faster-whisper-large-v3' },
  'faster-whisper-server': { baseUrl: 'http://localhost:8000/v1', model: 'Systran/faster-whisper-large-v3' },
  localai: { baseUrl: 'http://localhost:8080/v1', model: 'whisper-1' },
} as const;

interface LaneSpec {
  service: string;
  tier: Tier;
  priority: number;
  quality: number;
  model: string;
  baseUrl: string;
  requires: string[];
  enabled: boolean;
  key?: string;
  keyVar?: string;
  modelVar?: string;
  maxBytes?: number;
  dialect?: Dialect;
  /** Requests and returns word timestamps. */
  words?: boolean;
  promptMaxChars?: number;
  minRetryAfterSec?: number;
}

function rung(spec: LaneSpec): SttRung {
  const ep: Endpoint = {
    baseUrl: spec.baseUrl.replace(/\/+$/, ''),
    model: spec.model,
    key: spec.key,
    label: spec.service,
    keyVar: spec.keyVar,
    modelVar: spec.modelVar,
    maxBytes: spec.maxBytes,
    dialect: spec.dialect,
    words: spec.words,
    promptMaxChars: spec.promptMaxChars,
    minRetryAfterSec: spec.minRetryAfterSec,
  };
  return {
    id: spec.model ? `stt/${spec.service}/${spec.model}` : `stt/${spec.service}`,
    provider: 'stt-openai-compatible',
    service: spec.service,
    model: spec.model,
    tier: spec.tier,
    priority: spec.priority,
    quality: spec.quality,
    capabilities: ['segments', ...(spec.words ? ['words'] : []), 'language-detect', 'prompt'],
    requires: spec.requires,
    isEnabled: () => spec.enabled,
    maxBytes: spec.maxBytes,
    transcribe: (audio, opts, ctx) => transcribeWith(ep, audio, opts, ctx),
  };
}

type KeyedSpec = Omit<LaneSpec, 'requires' | 'enabled' | 'key' | 'keyVar'>;

/** One rung per pooled key; a single disabled rung when no key is set, so health output shows what the key unlocks. */
function keyedRungs(env: Env, keyVar: string, spec: KeyedSpec): SttRung[] {
  const keys = keyPool(env, keyVar);
  if (keys.length === 0) return [rung({ ...spec, keyVar, requires: [keyVar], enabled: false })];
  return keys.map((k) =>
    rung({
      ...spec,
      service: pooledService(spec.service, k.index),
      key: k.key,
      keyVar: k.envVar,
      requires: [k.envVar],
      enabled: true,
    }),
  );
}

export function sttRungs(env: Env): SttRung[] {
  const localBase = env.LOCAL_STT_BASE_URL;
  const localModel = env.LOCAL_STT_MODEL;
  return [
    rung({
      service: 'local',
      tier: 'local',
      priority: 10,
      quality: 4,
      model: localModel ?? '',
      baseUrl: localBase || LOCAL_STT_PRESETS.speaches.baseUrl,
      key: env.LOCAL_STT_API_KEY || undefined,
      keyVar: 'LOCAL_STT_API_KEY',
      modelVar: 'LOCAL_STT_MODEL',
      requires: ['LOCAL_STT_BASE_URL', 'LOCAL_STT_MODEL'],
      enabled: Boolean(localBase && localModel),
    }),
    // True free tier: 25 MB per file, 224-token prompt, word timestamps (console.groq.com/docs/speech-to-text, 2026-11-14).
    ...keyedRungs(env, 'GROQ_API_KEY', {
      service: 'groq',
      tier: 'free',
      priority: 10,
      quality: 4,
      model: env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
      modelVar: 'GROQ_STT_MODEL',
      baseUrl: GROQ_BASE_URL,
      maxBytes: 25 * MB,
      words: true,
    }),
    // Experiment plan (free, rate limited, prompts may be used for training). Segments only, no word timestamps.
    ...keyedRungs(env, 'MISTRAL_API_KEY', {
      service: 'mistral',
      tier: 'free',
      priority: 20,
      quality: 4,
      model: env.MISTRAL_STT_MODEL || 'voxtral-mini-transcribe-3',
      modelVar: 'MISTRAL_STT_MODEL',
      baseUrl: MISTRAL_BASE_URL,
      dialect: 'mistral',
      promptMaxChars: 2000,
    }),
    // Keyless: about 2 requests per minute per IP (x-ratelimit-limit-minute: 2), so a 429 cools down at least 30 s.
    rung({
      service: 'ovh',
      tier: 'keyless',
      priority: 10,
      quality: 4,
      model: env.OVH_STT_MODEL || 'whisper-large-v3-turbo',
      modelVar: 'OVH_STT_MODEL',
      baseUrl: OVH_BASE_URL,
      requires: [],
      enabled: true,
      words: true,
      minRetryAfterSec: 30,
    }),
    // Paid, cheapest first. DeepInfra: about $0.0002 per audio minute for whisper-large-v3-turbo.
    ...keyedRungs(env, 'DEEPINFRA_API_KEY', {
      service: 'deepinfra',
      tier: 'paid',
      priority: 10,
      quality: 4,
      model: env.DEEPINFRA_STT_MODEL || 'openai/whisper-large-v3-turbo',
      modelVar: 'DEEPINFRA_STT_MODEL',
      baseUrl: env.DEEPINFRA_BASE_URL || DEEPINFRA_BASE_URL,
      words: true,
    }),
    // Together: 80 MB per direct upload, word timestamps with verbose_json.
    ...keyedRungs(env, 'TOGETHER_API_KEY', {
      service: 'together',
      tier: 'paid',
      priority: 20,
      quality: 4,
      model: env.TOGETHER_STT_MODEL || 'openai/whisper-large-v3',
      modelVar: 'TOGETHER_STT_MODEL',
      baseUrl: env.TOGETHER_BASE_URL || TOGETHER_BASE_URL,
      maxBytes: 80 * MB,
      words: true,
    }),
    ...keyedRungs(env, 'OPENAI_API_KEY', {
      service: 'openai',
      tier: 'paid',
      priority: 30,
      quality: 4,
      model: env.OPENAI_STT_MODEL || 'whisper-1',
      modelVar: 'OPENAI_STT_MODEL',
      baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      maxBytes: 25 * MB,
      words: true,
    }),
  ];
}

const provider: SttProvider = defineProvider({
  id: 'stt-openai-compatible',
  kind: 'stt',
  name: 'OpenAI-compatible speech-to-text',
  runtimes: ['node', 'workers', 'browser'],
  rungs: sttRungs,
});

export default provider;
