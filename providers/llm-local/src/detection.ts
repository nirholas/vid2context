/**
 * Find local model servers on this machine and say how to enable them.
 *
 * Probes the default ports (and any base URLs already set in env) in parallel
 * with short timeouts, identifies each server from its responses, lists its
 * models, and returns suggested env lines plus a recommended model per task.
 * Every request goes to the addresses probed; nothing leaves the machine
 * unless you point a base URL elsewhere.
 *
 * Identification, strongest first:
 *   Ollama        GET /api/version answers {"version": ...}; models from /api/tags, details from /api/show
 *   llama.cpp     `Server: llama.cpp` header; n_ctx from /v1/models
 *   whisper.cpp   `Server: whisper.cpp` header (speech-to-text)
 *   vLLM          /v1/models entries with owned_by "vllm" and max_model_len
 *   anything else that answers /v1/models: an OpenAI-compatible server, named after the port's usual owner
 *
 * Runtime-neutral: no Node built-ins. The CLI in detect.ts adds RAM and GPU
 * memory (`hardware`) so recommendations fit the machine.
 */
import { type Ctx, type Env, fetchWithTimeout } from '@vid2context/core';
import { parseShow } from './ollama.ts';
import { normalizeOllamaBase, normalizeOpenAiBase, SERVERS, type ServerId } from './servers.ts';

export interface Hardware {
  totalRamBytes?: number;
  freeRamBytes?: number;
  gpus?: { name: string; memoryTotalMb: number; memoryFreeMb?: number }[];
}

export interface DetectOptions {
  /** Per-request timeout. Default 1500 ms. */
  timeoutMs?: number;
  /** RAM and GPU memory, for recommendations that fit the machine. */
  hardware?: Hardware;
}

export type ModelTask = 'chat' | 'embed' | 'stt';

export interface DetectedModel {
  id: string;
  task: ModelTask;
  /** Context window in tokens: the model maximum (Ollama, vLLM) or what the server was started with (llama.cpp). */
  contextLength?: number;
  capabilities: string[];
  parameterSize?: string;
  quantization?: string;
  sizeBytes?: number;
}

export type ServerKind = 'ollama' | 'llamacpp' | 'vllm' | 'whispercpp' | 'openai-compatible';

export interface DetectedServer {
  kind: ServerKind;
  name: string;
  baseUrl: string;
  version?: string;
  /** How it was identified: its own API, a Server header, a response field, or only the port it listens on. */
  identifiedBy: 'api' | 'header' | 'response' | 'port';
  /** For `port`: the servers that usually listen there. */
  likely?: string[];
  models: DetectedModel[];
}

export interface ProbeResult {
  url: string;
  status?: number;
  error?: string;
}

export interface Recommendation {
  task: 'briefs' | 'cleanup' | 'embeddings' | 'speech-to-text';
  server: string;
  model: string;
  contextLength?: number;
  why: string;
}

export interface DetectionReport {
  servers: DetectedServer[];
  probes: ProbeResult[];
  recommendations: Recommendation[];
  /** Lines to paste into .env (comments start with #). */
  env: string[];
  /** Next steps when something useful is missing (no server, no chat model, no embedding model). */
  suggestions: string[];
  hardware?: Hardware;
}

interface Probed {
  status: number;
  server: string;
  text: string;
}

async function get(
  ctx: Ctx,
  url: string,
  probes: ProbeResult[],
  timeoutMs: number,
  init?: RequestInit,
): Promise<Probed | undefined> {
  try {
    const res = await fetchWithTimeout(ctx, url, init, timeoutMs);
    const text = await res.text();
    probes.push({ url, status: res.status });
    return { status: res.status, server: res.headers.get('server') ?? '', text };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    probes.push({ url, error: e.cause?.code ?? e.name ?? 'error' });
    return undefined;
  }
}

function json<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

const STT_ID = /whisper|parakeet|canary|moonshine|distil-large/i;
const EMBED_ID = /embed|bge-|\bbge\b|e5-|minilm|nomic-bert|gte-/i;

function taskFromId(id: string): ModelTask {
  if (STT_ID.test(id)) return 'stt';
  if (EMBED_ID.test(id)) return 'embed';
  return 'chat';
}

// ---------------------------------------------------------------- Ollama

interface TagsResponse {
  models?: {
    name: string;
    size?: number;
    details?: { family?: string; parameter_size?: string; quantization_level?: string; context_length?: number };
    capabilities?: string[];
  }[];
}

async function probeOllama(
  ctx: Ctx,
  base: string,
  probes: ProbeResult[],
  timeoutMs: number,
): Promise<DetectedServer | undefined> {
  const v = await get(ctx, `${base}/api/version`, probes, timeoutMs);
  const version = v?.status === 200 ? json<{ version?: string }>(v.text)?.version : undefined;
  if (!version) return undefined;
  const tags = await get(ctx, `${base}/api/tags`, probes, timeoutMs);
  const list = (tags?.status === 200 ? json<TagsResponse>(tags.text)?.models : undefined) ?? [];
  const models = await Promise.all(
    list.map(async (m): Promise<DetectedModel> => {
      // /api/show loads model metadata from disk; give it longer than a port probe.
      const show = await get(ctx, `${base}/api/show`, probes, Math.max(timeoutMs, 5000), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: m.name }),
      });
      const info = show?.status === 200 ? parseShow(json(show.text) ?? {}) : undefined;
      const capabilities = info?.capabilities.length ? info.capabilities : (m.capabilities ?? []);
      const embed =
        capabilities.includes('embedding') ||
        (capabilities.length === 0 && EMBED_ID.test(`${m.name} ${m.details?.family ?? ''}`));
      return {
        id: m.name,
        task: embed ? 'embed' : 'chat',
        contextLength: info?.contextLength ?? m.details?.context_length,
        capabilities,
        parameterSize: info?.parameterSize ?? m.details?.parameter_size,
        quantization: info?.quantization ?? m.details?.quantization_level,
        sizeBytes: m.size,
      };
    }),
  );
  return { kind: 'ollama', name: 'Ollama', baseUrl: base, version, identifiedBy: 'api', models };
}

// ---------------------------------------------------------------- OpenAI-compatible

interface ModelsResponse {
  data?: {
    id: string;
    owned_by?: string;
    max_model_len?: number;
    meta?: { n_ctx?: number; n_params?: number; size?: number };
  }[];
}

const NAMES: Record<string, string> = {
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp server',
  localai: 'LocalAI',
  vllm: 'vLLM',
  jan: 'Jan',
  speaches: 'speaches or faster-whisper-server',
  whispercpp: 'whisper.cpp server',
  local: 'OpenAI-compatible server',
  stt: 'speech-to-text server',
};

interface Candidate {
  base: string;
  likely: string[];
}

function origin(url: string): string {
  return new URL(url).origin;
}

async function probeOpenAi(
  ctx: Ctx,
  c: Candidate,
  probes: ProbeResult[],
  timeoutMs: number,
  ollamaOrigins: Set<string>,
): Promise<DetectedServer | undefined> {
  if (ollamaOrigins.has(origin(c.base))) return undefined;
  const r = await get(ctx, `${c.base}/models`, probes, timeoutMs);
  if (!r) return undefined;
  const server = r.server.toLowerCase();
  if (server.includes('whisper.cpp')) {
    return {
      kind: 'whispercpp',
      name: NAMES.whispercpp as string,
      baseUrl: origin(c.base),
      identifiedBy: 'header',
      models: [{ id: 'whisper-1', task: 'stt', capabilities: [] }],
    };
  }
  const body = r.status === 200 ? json<ModelsResponse>(r.text) : undefined;
  const data = body?.data;
  if (!Array.isArray(data)) return undefined;

  if (data.length > 0 && data.every((m) => m.owned_by === 'library')) {
    // Ollama's own OpenAI-compatible endpoint, on a non-default address.
    const found = await probeOllama(ctx, normalizeOllamaBase(c.base), probes, timeoutMs);
    if (found) {
      ollamaOrigins.add(origin(c.base));
      return found;
    }
  }

  const models: DetectedModel[] = data.map((m) => ({
    id: m.id,
    task: taskFromId(m.id),
    contextLength: m.meta?.n_ctx ?? m.max_model_len,
    capabilities: [],
    sizeBytes: m.meta?.size,
    parameterSize: m.meta?.n_params ? formatParams(m.meta.n_params) : undefined,
  }));
  if (server.includes('llama.cpp')) {
    return { kind: 'llamacpp', name: NAMES.llamacpp as string, baseUrl: c.base, identifiedBy: 'header', models };
  }
  if (data.some((m) => m.owned_by === 'vllm')) {
    return { kind: 'vllm', name: NAMES.vllm as string, baseUrl: c.base, identifiedBy: 'response', models };
  }
  const likely = models.length > 0 && models.every((m) => m.task === 'stt') ? ['speaches', 'stt'] : c.likely;
  return {
    kind: 'openai-compatible',
    name: likely.map((l) => NAMES[l] ?? l).join(' or '),
    baseUrl: c.base,
    identifiedBy: 'port',
    likely,
    models,
  };
}

function formatParams(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : `${Math.round(n / 1e6)}M`;
}

/** Default ports of OpenAI-compatible servers and who usually listens there. */
const DEFAULT_PORTS: Candidate[] = [
  { base: 'http://localhost:1234/v1', likely: ['lmstudio'] },
  { base: 'http://localhost:8080/v1', likely: ['llamacpp', 'localai'] },
  { base: 'http://localhost:8000/v1', likely: ['vllm', 'speaches'] },
  { base: 'http://localhost:1337/v1', likely: ['jan'] },
];

function candidates(env: Env): { ollama: string[]; openai: Candidate[] } {
  const ollama = [...new Set([normalizeOllamaBase(undefined), normalizeOllamaBase(env.OLLAMA_BASE_URL)])];
  const openai: Candidate[] = [...DEFAULT_PORTS];
  for (const s of SERVERS) {
    if (s.api === 'openai' && env[s.baseVar])
      openai.push({ base: normalizeOpenAiBase(env[s.baseVar] as string), likely: [s.service] });
  }
  if (env.LOCAL_STT_BASE_URL) openai.push({ base: normalizeOpenAiBase(env.LOCAL_STT_BASE_URL), likely: ['stt'] });
  const seen = new Map<string, Candidate>();
  for (const c of openai) {
    const prev = seen.get(c.base);
    if (prev) prev.likely = [...new Set([...c.likely, ...prev.likely])];
    else seen.set(c.base, { ...c });
  }
  return { ollama, openai: [...seen.values()] };
}

// ---------------------------------------------------------------- recommendations and env

/** Parameter count from "494.03M", "3.1B", "70B". */
function params(m: DetectedModel): number | undefined {
  const match = m.parameterSize?.match(/([\d.]+)\s*([MBK])/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = (match[2] as string).toUpperCase();
  return n * (unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : 1e3);
}

function weight(m: DetectedModel): number {
  return params(m) ?? m.sizeBytes ?? 0;
}

/** Memory a model can use: the largest GPU when there is one, else three quarters of RAM. */
function memoryBudget(hw: Hardware | undefined): number | undefined {
  const gpu = hw?.gpus?.length ? Math.max(...hw.gpus.map((g) => g.memoryTotalMb)) * 1024 * 1024 : undefined;
  if (gpu) return gpu;
  return hw?.totalRamBytes ? hw.totalRamBytes * 0.75 : undefined;
}

function fits(m: DetectedModel, budget: number | undefined): boolean {
  if (!budget || !m.sizeBytes) return true;
  return m.sizeBytes * 1.3 < budget;
}

/** Tokens per minute of speech, measured on a real 18-minute English transcript (about 4,600 tokens). */
const TOKENS_PER_MINUTE = 255;

function minutes(ctxLen: number | undefined): string {
  if (!ctxLen) return 'context length not reported';
  const mins = Math.floor((ctxLen - 2048) / TOKENS_PER_MINUTE);
  return `${ctxLen.toLocaleString('en-US')} tokens, about ${Math.max(mins, 0)} minutes of transcript`;
}

interface Placed {
  server: DetectedServer;
  model: DetectedModel;
}

function recommend(servers: DetectedServer[], hw: Hardware | undefined): Recommendation[] {
  const all: Placed[] = servers.flatMap((server) => server.models.map((model) => ({ server, model })));
  const chat = all.filter((p) => p.model.task === 'chat');
  const budget = memoryBudget(hw);
  const out: Recommendation[] = [];
  if (chat.length > 0) {
    const fitting = chat.filter((p) => fits(p.model, budget));
    const pool = fitting.length > 0 ? fitting : chat;
    const long = pool.filter((p) => !p.model.contextLength || p.model.contextLength >= 8192);
    const brief = [...(long.length > 0 ? long : pool)].sort((a, b) => weight(b.model) - weight(a.model))[0] as Placed;
    const cleanup = [...pool].sort((a, b) => weight(a.model) - weight(b.model))[0] as Placed;
    out.push({
      task: 'briefs',
      server: brief.server.name,
      model: brief.model.id,
      contextLength: brief.model.contextLength,
      why: `largest chat model${budget ? ' that fits in memory' : ''} (${brief.model.parameterSize ?? 'size unknown'}; ${minutes(brief.model.contextLength)})`,
    });
    if (cleanup.model.id !== brief.model.id || cleanup.server !== brief.server) {
      out.push({
        task: 'cleanup',
        server: cleanup.server.name,
        model: cleanup.model.id,
        contextLength: cleanup.model.contextLength,
        why: `smallest, fastest chat model (${cleanup.model.parameterSize ?? 'size unknown'}; ${minutes(cleanup.model.contextLength)})`,
      });
    }
  }
  const embed = all.find((p) => p.model.task === 'embed' && p.server.kind === 'ollama');
  if (embed) {
    out.push({
      task: 'embeddings',
      server: embed.server.name,
      model: embed.model.id,
      contextLength: embed.model.contextLength,
      why: 'Ollama embedding model',
    });
  }
  const stt = all.find((p) => p.model.task === 'stt');
  if (stt) out.push({ task: 'speech-to-text', server: stt.server.name, model: stt.model.id, why: 'local speech-to-text server' });
  return out;
}

const PREFIX: Partial<Record<ServerId, string>> = { lmstudio: 'LMSTUDIO', llamacpp: 'LLAMACPP', vllm: 'VLLM', jan: 'JAN' };

function envLines(servers: DetectedServer[], recs: Recommendation[]): string[] {
  const lines: string[] = [];
  const brief = recs.find((r) => r.task === 'briefs');
  const cleanup = recs.find((r) => r.task === 'cleanup');
  /** Chat models for a server: the recommended ones first (briefs, then cleanup), else every chat model. */
  const chatList = (s: DetectedServer) => {
    const chat = s.models.filter((m) => m.task === 'chat').map((m) => m.id);
    const picked = [brief, cleanup]
      .filter((r) => r && r.server === s.name && chat.includes(r.model))
      .map((r) => r?.model as string);
    return picked.length > 0 ? picked : chat;
  };

  for (const s of servers) {
    const chat = chatList(s);
    const header = `# ${s.name}${s.version ? ` ${s.version}` : ''} at ${s.baseUrl}${s.identifiedBy === 'port' ? ' (identified by its port only)' : ''}`;
    if (s.kind === 'whispercpp') {
      lines.push(
        header,
        '# whisper-server answers the OpenAI route only when started with --inference-path /v1/audio/transcriptions.',
      );
      lines.push(`LOCAL_STT_BASE_URL=${s.baseUrl}/v1`, 'LOCAL_STT_MODEL=whisper-1', '');
      continue;
    }
    const sttModels = s.models.filter((m) => m.task === 'stt');
    const block: string[] = [];
    if (s.kind === 'ollama') {
      if (chat.length > 0) block.push(`OLLAMA_MODEL=${chat.join(',')}`);
      if (s.baseUrl !== normalizeOllamaBase(undefined)) block.push(`OLLAMA_BASE_URL=${s.baseUrl}`);
      const embed = s.models.find((m) => m.task === 'embed');
      if (embed) block.push(`OLLAMA_EMBED_MODEL=${embed.id}`);
    } else if (chat.length > 0) {
      const id =
        s.kind === 'llamacpp'
          ? 'llamacpp'
          : s.kind === 'vllm'
            ? 'vllm'
            : s.likely?.length === 1
              ? (s.likely[0] as ServerId)
              : undefined;
      const prefix = id ? PREFIX[id] : undefined;
      const def = id ? SERVERS.find((x) => x.service === id)?.defaultBase : undefined;
      if (prefix) {
        block.push(`${prefix}_MODEL=${chat.join(',')}`);
        if (s.baseUrl !== def) block.push(`${prefix}_BASE_URL=${s.baseUrl}`);
      } else {
        block.push(`LOCAL_LLM_BASE_URL=${s.baseUrl}`, `LOCAL_LLM_MODEL=${chat.join(',')}`);
      }
    }
    if (sttModels.length > 0)
      block.push(`LOCAL_STT_BASE_URL=${s.baseUrl}`, `LOCAL_STT_MODEL=${(sttModels[0] as DetectedModel).id}`);
    if (block.length > 0) lines.push(header, ...block, '');
  }
  if (lines.length > 0 && servers.some((s) => s.kind === 'ollama'))
    lines.push('# Optional: keep Ollama models loaded between requests.', '# OLLAMA_KEEP_ALIVE=30m', '');
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

function pullSuggestion(hw: Hardware | undefined): string {
  const budget = memoryBudget(hw);
  const gb = budget ? budget / 1024 ** 3 : undefined;
  if (gb === undefined) return 'ollama pull qwen2.5:3b';
  if (gb >= 24) return 'ollama pull qwen2.5:14b';
  if (gb >= 12) return 'ollama pull qwen2.5:7b';
  if (gb >= 6) return 'ollama pull qwen2.5:3b';
  return 'ollama pull qwen2.5:1.5b';
}

function suggestions(servers: DetectedServer[], recs: Recommendation[], hw: Hardware | undefined): string[] {
  const out: string[] = [];
  const ollama = servers.find((s) => s.kind === 'ollama');
  if (servers.length === 0) {
    out.push('No local model server found. Install Ollama (https://ollama.com/download), then run:', `  ${pullSuggestion(hw)}`);
    return out;
  }
  if (!recs.some((r) => r.task === 'briefs')) out.push(`No chat model installed. With Ollama: ${pullSuggestion(hw)}`);
  if (ollama && !ollama.models.some((m) => m.task === 'embed'))
    out.push('For local search embeddings: ollama pull nomic-embed-text');
  return out;
}

/** Probe this machine for local LLM, embedding and speech-to-text servers. */
export async function detectLocalServers(ctx: Ctx, opts: DetectOptions = {}): Promise<DetectionReport> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const probes: ProbeResult[] = [];
  const { ollama, openai } = candidates(ctx.env);

  const ollamaFound = (await Promise.all(ollama.map((b) => probeOllama(ctx, b, probes, timeoutMs)))).filter(
    (s): s is DetectedServer => Boolean(s),
  );
  const ollamaOrigins = new Set(ollamaFound.map((s) => origin(s.baseUrl)));
  const others = (await Promise.all(openai.map((c) => probeOpenAi(ctx, c, probes, timeoutMs, ollamaOrigins)))).filter(
    (s): s is DetectedServer => Boolean(s),
  );
  const servers: DetectedServer[] = [];
  for (const s of [...ollamaFound, ...others]) {
    if (!servers.some((x) => x.kind === s.kind && x.baseUrl === s.baseUrl)) servers.push(s);
  }
  const recommendations = recommend(servers, opts.hardware);
  return {
    servers,
    probes,
    recommendations,
    env: envLines(servers, recommendations),
    suggestions: suggestions(servers, recommendations, opts.hardware),
    hardware: opts.hardware,
  };
}
