/**
 * Ollama through its native API (POST /api/chat), not the OpenAI-compatible
 * one, because only the native API lets a request set `options.num_ctx`.
 *
 * The trap this avoids: Ollama loads a model with a small default context
 * (4096 tokens on 0.40, with a 2050-token prompt limit) and silently drops the
 * start of any longer prompt. An 18-minute transcript is about 4,600 tokens,
 * so most of it would vanish with no error. Here every request sizes num_ctx
 * from the prompt, capped by the model's own maximum read once from
 * /api/show, and a prompt that cannot fit throws `too-large` instead.
 */
import {
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type Ctx,
  errorFromResponse,
  estimateTokens,
  fetchWithTimeout,
  Vid2ContextError,
} from '@vid2context/core';
import { buildBody } from '@vid2context/provider-llm-openai-compatible';
import { openStream, readLines, ThinkSplitter } from './stream.ts';

export interface OllamaModelInfo {
  /** The model's maximum context length (`<arch>.context_length` in model_info). */
  contextLength?: number;
  /** As reported: completion, tools, vision, thinking, embedding, insert. */
  capabilities: string[];
  parameterSize?: string;
  quantization?: string;
  family?: string;
}

interface ShowResponse {
  model_info?: Record<string, unknown>;
  capabilities?: string[];
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
}

/** Parse an /api/show response. */
export function parseShow(json: ShowResponse): OllamaModelInfo {
  let contextLength: number | undefined;
  for (const [k, v] of Object.entries(json.model_info ?? {})) {
    if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) contextLength = v;
  }
  return {
    contextLength,
    capabilities: json.capabilities ?? [],
    parameterSize: json.details?.parameter_size || undefined,
    quantization: json.details?.quantization_level || undefined,
    family: json.details?.family || undefined,
  };
}

const showCache = new Map<string, Promise<OllamaModelInfo>>();
/** Settled /api/show results, readable synchronously by the rung factory. */
const settled = new Map<string, OllamaModelInfo>();
const versionCache = new Map<string, Promise<string | undefined>>();

/** Model info from /api/show, fetched once per base URL and model for the life of the process. */
export function showModel(base: string, model: string, ctx: Ctx): Promise<OllamaModelInfo> {
  const key = `${base}|${model}`;
  let p = showCache.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetchWithTimeout(
        ctx,
        `${base}/api/show`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) },
        15_000,
      );
      if (res.status === 404) throw modelMissing(model, await res.text().catch(() => ''));
      if (!res.ok) throw await errorFromResponse(res, 'ollama show');
      const info = parseShow((await res.json()) as ShowResponse);
      settled.set(key, info);
      return info;
    })();
    showCache.set(key, p);
    p.catch(() => showCache.delete(key));
  }
  return p;
}

/** Model info when /api/show already succeeded in this process (synchronous, no network). */
export function cachedModelInfo(base: string, model: string): OllamaModelInfo | undefined {
  return settled.get(`${base}|${model}`);
}

/** Server version from /api/version, once per base URL. Undefined when the server does not say. */
export function serverVersion(base: string, ctx: Ctx): Promise<string | undefined> {
  let p = versionCache.get(base);
  if (!p) {
    p = (async () => {
      const res = await fetchWithTimeout(ctx, `${base}/api/version`, {}, 5_000);
      if (!res.ok) return undefined;
      const json = (await res.json()) as { version?: string };
      return json.version;
    })().catch(() => undefined);
    versionCache.set(base, p);
  }
  return p;
}

/** True when `version` is at least `min` (dotted numbers; pre-release suffixes ignored). */
export function versionAtLeast(version: string | undefined, min: string): boolean {
  if (!version) return false;
  const a = version.replace(/^v/, '').split(/[.-]/).map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    const x = Number.isFinite(a[i]) ? (a[i] as number) : 0;
    const y = b[i] as number;
    if (x !== y) return x > y;
  }
  return true;
}

function modelMissing(model: string, body: string): Vid2ContextError {
  return new Vid2ContextError('not-found', `ollama: model ${model} is not installed${body ? ` (${body.slice(0, 200)})` : ''}.`, {
    status: 404,
    hint: `Run \`ollama pull ${model}\`, or set OLLAMA_MODEL to a model from \`ollama list\`.`,
  });
}

/** Default answer budget when the request does not set maxTokens. */
const DEFAULT_OUTPUT = 2048;
/** Chat template tokens per message (role markers, separators). */
const PER_MESSAGE = 8;
/** Smallest answer budget worth running a request for. */
const MIN_OUTPUT = 256;
/** num_ctx is rounded up to this step so similar requests reuse the loaded model instead of reloading it. */
const STEP = 2048;

export interface ContextPlan {
  /** Estimated prompt tokens, with headroom for estimate error. */
  promptTokens: number;
  numCtx: number;
  /** Answer budget sent as num_predict. */
  numPredict: number;
}

/**
 * Size num_ctx for a request. The estimate runs about 3% under Ollama's real
 * count on English transcripts, so it gets 15% headroom. num_ctx covers the
 * prompt plus the answer budget, rounded up to a 2048 step, never above the
 * model's maximum. num_predict is clamped so generation cannot run past the
 * window (Ollama would otherwise shift the context and drop the start).
 */
export function planContext(req: ChatRequest, maxContext: number | undefined, model: string): ContextPlan {
  const raw = req.messages.reduce((n, m) => n + estimateTokens(m.content) + PER_MESSAGE, 0);
  const promptTokens = Math.ceil(raw * 1.15) + 32;
  const wanted = req.maxTokens ?? DEFAULT_OUTPUT;
  let numCtx = Math.ceil((promptTokens + wanted) / STEP) * STEP;
  if (maxContext !== undefined) {
    if (promptTokens + Math.min(wanted, MIN_OUTPUT) > maxContext) {
      throw new Vid2ContextError(
        'too-large',
        `ollama ${model}: the prompt is about ${promptTokens} tokens but the model's context window is ${maxContext}.`,
        {
          hint:
            'Use a model with a larger context window, for example `ollama pull llama3.1:8b` (128k tokens) and put it first in OLLAMA_MODEL, ' +
            'or ask about a shorter part of the video. vid2context refuses rather than letting Ollama silently drop the start of the transcript.',
        },
      );
    }
    numCtx = Math.min(numCtx, maxContext);
  }
  const numPredict = Math.min(wanted, numCtx - promptTokens);
  return { promptTokens, numCtx, numPredict };
}

export interface OllamaEndpoint {
  base: string;
  model: string;
  /** OLLAMA_KEEP_ALIVE: how long the model stays loaded after the request ("10m", "-1", "0"). */
  keepAlive?: string;
  timeoutMs?: number;
}

function keepAliveValue(v: string): string | number {
  return /^-?\d+$/.test(v) ? Number(v) : v;
}

/** Ollama 0.5.0 added JSON Schema in `format` (structured outputs). */
const SCHEMA_SINCE = '0.5.0';

/** Build the /api/chat body: model info decides num_ctx, the version decides schema support. */
export async function buildOllamaBody(
  ep: OllamaEndpoint,
  req: ChatRequest,
  ctx: Ctx,
  stream: boolean,
): Promise<{ body: Record<string, unknown>; plan: ContextPlan }> {
  const info = await showModel(ep.base, ep.model, ctx).catch((err) => {
    // A missing model fails the request now with a pull hint; any other
    // /api/show failure (an older server, a proxy) leaves num_ctx uncapped.
    if (err instanceof Vid2ContextError && err.code === 'not-found') throw err;
    ctx.log.warn(`ollama ${ep.model}: could not read the context length (${(err as Error).message}); num_ctx is not capped`);
    return undefined;
  });
  const plan = planContext(req, info?.contextLength, ep.model);

  let messages = req.messages;
  let format: unknown;
  if (req.json) {
    const schema = typeof req.json === 'object' ? req.json.schema : undefined;
    const useSchema = Boolean(schema) && versionAtLeast(await serverVersion(ep.base, ctx), SCHEMA_SINCE);
    // Reuse the foundation's JSON instruction so every lane prompts the same way.
    messages = buildBody({ url: '', model: ep.model, label: 'ollama', jsonSchema: useSchema }, req).messages as typeof messages;
    format = useSchema ? schema : 'json';
  }
  const options: Record<string, unknown> = { num_ctx: plan.numCtx, num_predict: plan.numPredict };
  if (req.temperature !== undefined) options.temperature = req.temperature;
  const body: Record<string, unknown> = { model: ep.model, messages, stream, options };
  if (format !== undefined) body.format = format;
  if (ep.keepAlive) body.keep_alive = keepAliveValue(ep.keepAlive);
  return { body, plan };
}

interface ChatChunk {
  model?: string;
  message?: { content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

async function failed(res: Response, model: string): Promise<Vid2ContextError> {
  if (res.status === 404) return modelMissing(model, await res.text().catch(() => ''));
  return errorFromResponse(res, 'ollama chat');
}

function emptyAnswer(reason: string | undefined): Vid2ContextError {
  return new Vid2ContextError('upstream', `ollama chat: empty answer${reason ? ` (done_reason ${reason})` : ''}.`, {
    hint: reason === 'length' ? 'The model used its whole token budget; raise maxTokens.' : undefined,
  });
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function warnIfTruncated(plan: ContextPlan, promptEval: number | undefined, ctx: Ctx, model: string): void {
  // Ollama reports the tokens it actually evaluated. Far fewer than estimated means the prompt was cut.
  if (promptEval !== undefined && promptEval < plan.promptTokens * 0.5) {
    ctx.log.warn(`ollama ${model}: evaluated ${promptEval} prompt tokens, expected about ${plan.promptTokens}`);
  }
}

export async function ollamaChat(ep: OllamaEndpoint, req: ChatRequest, ctx: Ctx): Promise<ChatResult> {
  const { body, plan } = await buildOllamaBody(ep, req, ctx, false);
  const res = await fetchWithTimeout(
    ctx,
    `${ep.base}/api/chat`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    ep.timeoutMs ?? 600_000,
  );
  if (!res.ok) throw await failed(res, ep.model);
  const json = (await res.json()) as ChatChunk;
  if (json.error) throw new Vid2ContextError('upstream', `ollama chat: ${json.error}`);
  const text = stripThink(json.message?.content ?? '');
  if (!text) throw emptyAnswer(json.done_reason);
  warnIfTruncated(plan, json.prompt_eval_count, ctx, ep.model);
  return {
    text,
    model: json.model ?? ep.model,
    usage: { inputTokens: json.prompt_eval_count, outputTokens: json.eval_count },
  };
}

/** Stream /api/chat: one JSON object per line, the last with done: true and token counts. */
export async function* ollamaStream(ep: OllamaEndpoint, req: ChatRequest, ctx: Ctx): AsyncIterable<ChatStreamEvent> {
  const { body, plan } = await buildOllamaBody(ep, req, ctx, true);
  const { res, touch, done } = await openStream(
    ctx,
    `${ep.base}/api/chat`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    ep.timeoutMs ?? 300_000,
  );
  try {
    if (!res.ok) throw await failed(res, ep.model);
    if (!res.body) throw new Vid2ContextError('upstream', 'ollama chat: empty stream.');
    const split = new ThinkSplitter();
    let text = '';
    let last: ChatChunk | undefined;
    for await (const line of readLines(res.body, touch)) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line) as ChatChunk;
      if (chunk.error) throw new Vid2ContextError('upstream', `ollama chat: ${chunk.error}`);
      if (chunk.message?.thinking) yield { type: 'reasoning', text: chunk.message.thinking };
      if (chunk.message?.content) {
        const part = split.push(chunk.message.content);
        if (part.reasoning) yield { type: 'reasoning', text: part.reasoning };
        if (part.answer) {
          text += part.answer;
          yield { type: 'delta', text: part.answer };
        }
      }
      if (chunk.done) last = chunk;
    }
    const tail = split.end();
    if (tail.reasoning) yield { type: 'reasoning', text: tail.reasoning };
    if (tail.answer) {
      text += tail.answer;
      yield { type: 'delta', text: tail.answer };
    }
    if (!text.trim()) throw emptyAnswer(last?.done_reason);
    warnIfTruncated(plan, last?.prompt_eval_count, ctx, ep.model);
    yield {
      type: 'done',
      result: {
        text: text.trim(),
        model: last?.model ?? ep.model,
        usage: { inputTokens: last?.prompt_eval_count, outputTokens: last?.eval_count },
      },
    };
  } finally {
    done();
  }
}
