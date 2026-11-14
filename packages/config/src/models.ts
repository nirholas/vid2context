/**
 * Model override keys a profile may use under `models`, and the env var each
 * one compiles to. The names follow docs/providers.md and the naming rules in
 * docs/prompts/SHARED-CONTRACTS.md section 9: `<PROVIDER>_MODEL` for chat
 * models (a comma-separated list), `<PROVIDER>_STT_MODEL`,
 * `<PROVIDER>_EMBED_MODEL`, `<PROVIDER>_VIDEO_MODEL` and
 * `<PROVIDER>_VISION_MODEL` for the other rung kinds.
 *
 * Key form: the provider alone means its chat (LLM) models (`groq`), and
 * `<provider>:<kind>` names another kind (`groq:stt`, `ollama:embed`).
 */

export type ModelKind = 'llm' | 'stt' | 'embed' | 'video' | 'visual';

/** Which rung kinds each provider takes a model override for. */
const PROVIDER_KINDS: Record<string, ModelKind[]> = {
  // Local (this machine).
  ollama: ['llm', 'embed', 'visual'],
  lmstudio: ['llm', 'embed'],
  local: ['llm', 'stt', 'embed'],
  transformers: ['stt', 'embed'],
  webllm: ['llm'],
  // Free tiers with your own key.
  groq: ['llm', 'stt'],
  cerebras: ['llm'],
  mistral: ['llm'],
  github: ['llm'],
  gemini: ['llm', 'stt', 'embed', 'video', 'visual'],
  openrouter: ['llm'],
  cloudflare: ['stt', 'embed'],
  // Keyless hosts.
  ovh: ['llm', 'stt'],
  pollinations: ['llm'],
  // Paid.
  openai: ['llm', 'stt', 'embed'],
  anthropic: ['llm'],
  deepgram: ['stt'],
  assemblyai: ['stt'],
};

const SUFFIX: Record<ModelKind, string> = {
  llm: 'MODEL',
  stt: 'STT_MODEL',
  embed: 'EMBED_MODEL',
  video: 'VIDEO_MODEL',
  visual: 'VISION_MODEL',
};

function envNameFor(provider: string, kind: ModelKind): string {
  // The generic local chat server predates the convention: LOCAL_LLM_MODEL, not LOCAL_MODEL.
  if (provider === 'local' && kind === 'llm') return 'LOCAL_LLM_MODEL';
  return `${provider.toUpperCase()}_${SUFFIX[kind]}`;
}

/** Every accepted `models` key mapped to its env var, in a stable order. */
export const MODEL_KEYS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDER_KINDS).flatMap(([provider, kinds]) =>
      kinds.map((kind) => [kind === 'llm' ? provider : `${provider}:${kind}`, envNameFor(provider, kind)]),
    ),
  ),
);

/** The env var names `models` can produce. */
export const MODEL_ENV_VARS: ReadonlySet<string> = new Set(Object.values(MODEL_KEYS));
