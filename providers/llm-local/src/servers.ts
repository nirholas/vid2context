/**
 * The local chat servers vid2context knows, their env vars and default ports.
 *
 * Every server is enabled by its `<PREFIX>_MODEL` variable (a comma-separated
 * model list, tried in order). `<PREFIX>_BASE_URL` overrides the default
 * address. The generic `local` lane has no default address, so it also needs
 * LOCAL_LLM_BASE_URL.
 */
import type { Env } from '@vid2context/core';

export type ServerId = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'jan' | 'localai' | 'local';

export interface LocalServer {
  /** Rung service name: rung ids are `llm/<service>/<model>`. */
  service: ServerId;
  name: string;
  /** `ollama` speaks Ollama's native API; the rest speak OpenAI-compatible chat completions. */
  api: 'ollama' | 'openai';
  baseVar: string;
  modelVar: string;
  /** Optional bearer key for servers started with an API key. */
  keyVar?: string;
  /** Default base URL. Ollama's has no /v1 (native API); the rest end in /v1. */
  defaultBase?: string;
  priority: number;
  /** Honours response_format json_object. */
  json: boolean;
  /** Honours response_format json_schema. */
  jsonSchema: boolean;
}

export const SERVERS: LocalServer[] = [
  {
    service: 'ollama',
    name: 'Ollama',
    api: 'ollama',
    baseVar: 'OLLAMA_BASE_URL',
    modelVar: 'OLLAMA_MODEL',
    defaultBase: 'http://localhost:11434',
    priority: 10,
    json: true,
    jsonSchema: true,
  },
  {
    service: 'lmstudio',
    name: 'LM Studio',
    api: 'openai',
    baseVar: 'LMSTUDIO_BASE_URL',
    modelVar: 'LMSTUDIO_MODEL',
    keyVar: 'LMSTUDIO_API_KEY',
    defaultBase: 'http://localhost:1234/v1',
    priority: 20,
    json: true,
    jsonSchema: true,
  },
  {
    service: 'llamacpp',
    name: 'llama.cpp server',
    api: 'openai',
    baseVar: 'LLAMACPP_BASE_URL',
    modelVar: 'LLAMACPP_MODEL',
    keyVar: 'LLAMACPP_API_KEY',
    defaultBase: 'http://localhost:8080/v1',
    priority: 30,
    json: true,
    jsonSchema: true,
  },
  {
    service: 'vllm',
    name: 'vLLM',
    api: 'openai',
    baseVar: 'VLLM_BASE_URL',
    modelVar: 'VLLM_MODEL',
    keyVar: 'VLLM_API_KEY',
    defaultBase: 'http://localhost:8000/v1',
    priority: 40,
    json: true,
    jsonSchema: true,
  },
  {
    service: 'jan',
    name: 'Jan',
    api: 'openai',
    baseVar: 'JAN_BASE_URL',
    modelVar: 'JAN_MODEL',
    keyVar: 'JAN_API_KEY',
    defaultBase: 'http://localhost:1337/v1',
    priority: 50,
    json: false,
    jsonSchema: false,
  },
  {
    service: 'localai',
    name: 'LocalAI',
    api: 'openai',
    baseVar: 'LOCALAI_BASE_URL',
    modelVar: 'LOCALAI_MODEL',
    keyVar: 'LOCALAI_API_KEY',
    defaultBase: 'http://localhost:8080/v1',
    priority: 60,
    json: true,
    jsonSchema: false,
  },
  {
    service: 'local',
    name: 'OpenAI-compatible server',
    api: 'openai',
    baseVar: 'LOCAL_LLM_BASE_URL',
    modelVar: 'LOCAL_LLM_MODEL',
    keyVar: 'LOCAL_LLM_API_KEY',
    priority: 70,
    json: false,
    jsonSchema: false,
  },
];

export function serverById(id: ServerId): LocalServer {
  const s = SERVERS.find((x) => x.service === id);
  if (!s) throw new Error(`unknown local server ${id}`);
  return s;
}

/** Add http:// when missing and drop trailing slashes. */
function cleanUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
}

/**
 * Ollama's native API lives at the server root. The foundation documented
 * OLLAMA_BASE_URL with a /v1 suffix (the OpenAI-compatible path), so a value
 * ending in /v1 (or /api) is accepted and the suffix dropped.
 */
export function normalizeOllamaBase(raw: string | undefined): string {
  if (!raw?.trim()) return 'http://localhost:11434';
  return cleanUrl(raw).replace(/\/(v1|api)$/, '');
}

/** OpenAI-compatible base: the value as given (it should end in /v1), cleaned. */
export function normalizeOpenAiBase(raw: string): string {
  return cleanUrl(raw);
}

/** The base URL a server uses with this env, or undefined when it has none. */
export function baseUrlFor(server: LocalServer, env: Env): string | undefined {
  const raw = env[server.baseVar] || server.defaultBase;
  if (!raw) return undefined;
  return server.api === 'ollama' ? normalizeOllamaBase(raw) : normalizeOpenAiBase(raw);
}

/** Model ids from `<PREFIX>_MODEL`, in order. */
export function modelsFor(server: LocalServer, env: Env): string[] {
  return (env[server.modelVar] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
