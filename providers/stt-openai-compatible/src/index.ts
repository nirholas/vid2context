/**
 * Speech-to-text rungs for every OpenAI-compatible /audio/transcriptions API.
 *
 *   local    LOCAL_STT_BASE_URL + LOCAL_STT_MODEL (speaches, faster-whisper-server, LocalAI)
 *   free     Groq whisper-large-v3-turbo (GROQ_API_KEY, pooled with GROQ_FALLBACK_KEYS)
 *   keyless  OVH AI Endpoints whisper-large-v3-turbo (no account; about 2 requests/minute per IP)
 *   paid     OpenAI whisper-1 (OPENAI_API_KEY)
 *
 * Every model id can be overridden with <PROVIDER>_STT_MODEL.
 */
import { defineProvider, type Env, keyPool, pooledService, type SttProvider, type SttRung, type Tier } from '@vid2context/core';
import { type Endpoint, transcribeWith } from './client.ts';

export { parseVerboseJson, transcribeWith, uploadFilename } from './client.ts';
export { normalizeLanguage } from './languages.ts';

const MB = 1024 * 1024;
export const OVH_BASE_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';

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
  maxBytes?: number;
}

function rung(spec: LaneSpec): SttRung {
  const ep: Endpoint = {
    baseUrl: spec.baseUrl.replace(/\/+$/, ''),
    model: spec.model,
    key: spec.key,
    label: spec.service,
    maxBytes: spec.maxBytes,
  };
  return {
    id: spec.model ? `stt/${spec.service}/${spec.model}` : `stt/${spec.service}`,
    provider: 'stt-openai-compatible',
    service: spec.service,
    model: spec.model,
    tier: spec.tier,
    priority: spec.priority,
    quality: spec.quality,
    capabilities: ['segments', 'language-detect', 'prompt'],
    requires: spec.requires,
    isEnabled: () => spec.enabled,
    maxBytes: spec.maxBytes,
    transcribe: (audio, opts, ctx) => transcribeWith(ep, audio, opts, ctx),
  };
}

/** One rung per pooled key; a single disabled rung when no key is set, so health output shows what the key unlocks. */
function keyedRungs(env: Env, keyVar: string, spec: Omit<LaneSpec, 'requires' | 'enabled' | 'key'>): SttRung[] {
  const keys = keyPool(env, keyVar);
  if (keys.length === 0) return [rung({ ...spec, requires: [keyVar], enabled: false })];
  return keys.map((k) =>
    rung({ ...spec, service: pooledService(spec.service, k.index), key: k.key, requires: [k.envVar], enabled: true }),
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
      baseUrl: localBase || 'http://localhost:8000/v1',
      key: env.LOCAL_STT_API_KEY || undefined,
      requires: ['LOCAL_STT_BASE_URL', 'LOCAL_STT_MODEL'],
      enabled: Boolean(localBase && localModel),
    }),
    ...keyedRungs(env, 'GROQ_API_KEY', {
      service: 'groq',
      tier: 'free',
      priority: 10,
      quality: 4,
      model: env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
      baseUrl: 'https://api.groq.com/openai/v1',
      maxBytes: 25 * MB,
    }),
    rung({
      service: 'ovh',
      tier: 'keyless',
      priority: 10,
      quality: 4,
      model: env.OVH_STT_MODEL || 'whisper-large-v3-turbo',
      baseUrl: OVH_BASE_URL,
      requires: [],
      enabled: true,
    }),
    ...keyedRungs(env, 'OPENAI_API_KEY', {
      service: 'openai',
      tier: 'paid',
      priority: 10,
      quality: 4,
      model: env.OPENAI_STT_MODEL || 'whisper-1',
      baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      maxBytes: 25 * MB,
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
