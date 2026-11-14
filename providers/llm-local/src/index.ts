/**
 * Local LLM rungs: models running on this machine, free and private, and the
 * only rungs the `local-only` policy keeps.
 *
 *   ollama    native /api/chat with num_ctx sized per request (OLLAMA_MODEL)
 *   lmstudio  LM Studio (LMSTUDIO_MODEL)
 *   llamacpp  llama.cpp server (LLAMACPP_MODEL)
 *   vllm      vLLM (VLLM_MODEL)
 *   jan       Jan (JAN_MODEL)
 *   localai   LocalAI (LOCALAI_MODEL)
 *   local     any OpenAI-compatible server (LOCAL_LLM_BASE_URL + LOCAL_LLM_MODEL)
 *
 * Each `<PREFIX>_MODEL` is a comma-separated list; each model is its own rung,
 * tried in order. Rung ids keep the foundation's form, `llm/<service>/<model>`.
 * Every rung streams. detectLocalServers() finds servers and models on this
 * machine and prints the env lines that enable them.
 */
import { defineProvider, type Env, type LlmProvider, type StreamingLlmRung, Vid2ContextError } from '@vid2context/core';
import { cachedModelInfo, type OllamaEndpoint, ollamaChat, ollamaStream } from './ollama.ts';
import { type ChatEndpoint, openAiChat, openAiStream } from './openai.ts';
import { baseUrlFor, type LocalServer, modelsFor, SERVERS } from './servers.ts';

export type { DetectedModel, DetectedServer, DetectionReport, DetectOptions, Hardware } from './detection.ts';
export { detectLocalServers } from './detection.ts';
export { normalizeOllamaBase, SERVERS } from './servers.ts';

/** Map Ollama's reported capabilities onto rung capability flags. */
function ollamaCapabilities(reported: string[]): string[] {
  const out: string[] = [];
  if (reported.includes('tools')) out.push('tools');
  if (reported.includes('vision')) out.push('vision');
  if (reported.includes('thinking')) out.push('reasoning');
  return out;
}

function placeholder(server: LocalServer): StreamingLlmRung {
  const requires = [server.modelVar, ...(server.defaultBase ? [] : [server.baseVar])];
  const off = (): Promise<never> =>
    Promise.reject(
      new Vid2ContextError('no-provider', `${server.name}: ${requires.join(' and ')} not set.`, {
        hint: `Set ${requires.join(' and ')} in .env, or run \`npx tsx providers/llm-local/src/detect.ts\` to find local models.`,
      }),
    );
  return {
    id: `llm/${server.service}`,
    provider: 'llm-local',
    service: server.service,
    model: '',
    tier: 'local',
    priority: server.priority,
    quality: 3,
    capabilities: [],
    requires,
    isEnabled: () => false,
    chat: off,
    stream: () => ({ [Symbol.asyncIterator]: () => ({ next: off }) }),
  };
}

function serverRungs(server: LocalServer, env: Env): StreamingLlmRung[] {
  const models = modelsFor(server, env);
  const base = baseUrlFor(server, env);
  if (models.length === 0 || !base) return [placeholder(server)];
  const requires = [server.modelVar, ...(server.defaultBase ? [] : [server.baseVar])];

  return models.map((model, i): StreamingLlmRung => {
    const common = {
      id: `llm/${server.service}/${model}`,
      provider: 'llm-local',
      service: server.service,
      model,
      tier: 'local' as const,
      priority: server.priority + i,
      quality: 3,
      requires,
      isEnabled: () => true,
    };
    if (server.api === 'ollama') {
      const ep: OllamaEndpoint = { base, model, keepAlive: env.OLLAMA_KEEP_ALIVE || undefined };
      const info = cachedModelInfo(base, model);
      return {
        ...common,
        capabilities: ['json', 'json-schema', ...ollamaCapabilities(info?.capabilities ?? [])],
        contextTokens: info?.contextLength,
        chat: (req, ctx) => ollamaChat(ep, req, ctx),
        stream: (req, ctx) => ollamaStream(ep, req, ctx),
      };
    }
    const ep: ChatEndpoint = {
      url: `${base}/chat/completions`,
      model,
      key: server.keyVar ? env[server.keyVar] || undefined : undefined,
      label: server.service,
      jsonSchema: server.jsonSchema,
      // Local inference on a CPU can take minutes for a long transcript.
      timeoutMs: 600_000,
    };
    return {
      ...common,
      capabilities: [...(server.json ? ['json'] : []), ...(server.jsonSchema ? ['json-schema'] : [])],
      chat: (req, ctx) => openAiChat(ep, req, ctx),
      stream: (req, ctx) => openAiStream(ep, req, ctx),
    };
  });
}

export function localRungs(env: Env): StreamingLlmRung[] {
  return SERVERS.flatMap((s) => serverRungs(s, env));
}

const provider: LlmProvider = defineProvider({
  id: 'llm-local',
  kind: 'llm',
  name: 'Local LLM servers (Ollama, LM Studio, llama.cpp, vLLM, Jan, LocalAI)',
  runtimes: ['node', 'browser'],
  rungs: localRungs,
});

export default provider;
