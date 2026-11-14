/**
 * Client for Gemini's native generateContent API, used for both Google AI
 * Studio (generativelanguage.googleapis.com, `x-goog-api-key`) and Gemini on
 * Vertex AI (aiplatform.googleapis.com, OAuth bearer token). The request and
 * response bodies are the same; only the URL and auth differ.
 *
 * Caching: Gemini 2.5 and newer cache repeated prompt prefixes implicitly
 * (no request field needed; minimum 2,048 to 4,096 tokens by model) and
 * report hits in `usageMetadata.cachedContentTokenCount`. Keeping the
 * transcript in `systemInstruction` and the first turns stable is what makes
 * the prefix repeat. Explicit `cachedContents` entries are not created: they
 * were not verifiable live for this release.
 */
import {
  type ChatMessage,
  type ChatRequest,
  type ChatStreamEvent,
  type Ctx,
  fetchWithTimeout,
  parseSSE,
  Vid2ContextError,
} from '@vid2context/core';
import { type NativeChatResult, type NativeUsage, tryJson } from './common.ts';

export interface GeminiTarget {
  label: string;
  model: string;
  /** Full :generateContent URL. */
  url: string;
  /** Full :streamGenerateContent?alt=sse URL. */
  streamUrl: string;
  headers(ctx: Ctx): Promise<Record<string, string>>;
  authHint: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------- JSON Schema

/**
 * Keywords Gemini's structured output ignores (it strips them during request
 * normalization), dropped here so the schema sent is the schema enforced:
 * validate these in code if they matter.
 */
const GEMINI_IGNORED = new Set([
  '$schema',
  '$id',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
]);

const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions']);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

/** Convert a JSON Schema for `generationConfig.responseJsonSchema`: drops the keywords listed in GEMINI_IGNORED, recursively. */
export function geminiSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (GEMINI_IGNORED.has(k)) continue;
    if (SCHEMA_MAPS.has(k) && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, geminiSchema(s)]));
    } else if (SCHEMA_LISTS.has(k) && Array.isArray(v)) {
      out[k] = v.map(geminiSchema);
    } else if ((k === 'items' || k === 'additionalProperties') && v && typeof v === 'object') {
      out[k] = geminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- request

interface Part {
  text?: string;
  thought?: boolean;
}

interface Content {
  role?: string;
  parts?: Part[];
}

export function geminiContents(messages: ChatMessage[]): { systemInstruction?: Content; contents: Content[] } {
  const system = messages
    .filter((m) => m.role === 'system' && m.content.trim())
    .map((m) => m.content)
    .join('\n\n');
  const contents: Content[] = messages
    .filter((m) => m.role !== 'system' && m.content.trim() !== '')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  return { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents };
}

export function buildGeminiBody(req: ChatRequest, opts: { stream?: boolean } = {}): Record<string, unknown> {
  const { systemInstruction, contents } = geminiContents(req.messages);
  const generationConfig: Record<string, unknown> = {};
  if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.json) {
    generationConfig.responseMimeType = 'application/json';
    if (typeof req.json === 'object') generationConfig.responseJsonSchema = geminiSchema(req.json.schema);
  }
  // Streaming asks for thought summaries so a UI can show reasoning; models without thinking ignore it.
  if (opts.stream) generationConfig.thinkingConfig = { includeThoughts: true };
  return {
    ...(systemInstruction ? { systemInstruction } : {}),
    contents,
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
}

// ---------------------------------------------------------------- errors

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { '@type'?: string; reason?: string; retryDelay?: string }[];
  };
}

/** "37s" or "1.5s" from a google.rpc.RetryInfo detail. */
function retryDelaySec(body: GoogleErrorBody | undefined): number | undefined {
  for (const d of body?.error?.details ?? []) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay ?? '');
    if (m) return Math.max(1, Math.ceil(Number(m[1])));
  }
  return undefined;
}

/** Map a non-2xx Google API response (AI Studio or Vertex). */
export async function googleError(res: Response, target: Pick<GeminiTarget, 'label' | 'authHint'>): Promise<Vid2ContextError> {
  const raw = await res.text().catch(() => '');
  const parsed = tryJson<GoogleErrorBody | GoogleErrorBody[]>(raw);
  // streamGenerateContent without alt=sse wraps errors in an array.
  const body = Array.isArray(parsed) ? parsed[0] : parsed;
  const detail = body?.error?.message ?? raw.slice(0, 500);
  const status = body?.error?.status;
  const reasons = (body?.error?.details ?? []).map((d) => d.reason).filter(Boolean);
  const s = res.status;
  const msg = `${target.label} chat: HTTP ${s}${status ? ` ${status}` : ''}${detail ? `: ${detail}` : ''}`;
  const headerRetry = Number(res.headers.get('retry-after'));
  if (s === 429) {
    return new Vid2ContextError('rate-limited', msg, {
      status: s,
      retryAfterSec: retryDelaySec(body) ?? (headerRetry > 0 ? headerRetry : undefined),
      hint: 'Quota exhausted for this key and model. The chain moves on and retries this rung after the delay.',
    });
  }
  if (reasons.includes('API_KEY_INVALID') || s === 401)
    return new Vid2ContextError('auth', msg, { status: s, hint: target.authHint });
  if (s === 403) {
    const billing = /billing/i.test(detail);
    const disabled = reasons.includes('SERVICE_DISABLED');
    return new Vid2ContextError('auth', msg, {
      status: s,
      hint: billing
        ? 'The Google Cloud project has a billing problem. Fix billing for the project, or use another project.'
        : disabled
          ? 'The API is not enabled for this project. Enable it in the Google Cloud console and retry.'
          : target.authHint,
    });
  }
  if (s === 404)
    return new Vid2ContextError('not-found', msg, {
      status: s,
      hint: 'The model id is unknown or retired here. Set a current id in the model env var.',
    });
  if (s === 413) return new Vid2ContextError('too-large', msg, { status: s });
  return new Vid2ContextError('upstream', msg, { status: s });
}

// ---------------------------------------------------------------- responses

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GenerateContentResponse {
  candidates?: { content?: Content; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: UsageMetadata;
  modelVersion?: string;
}

/** promptTokenCount includes cached tokens; inputTokens here is the uncached part, so the two never double count. */
export function mapGeminiUsage(u: UsageMetadata | undefined): NativeUsage | undefined {
  if (!u) return undefined;
  const cached = u.cachedContentTokenCount ?? 0;
  const out: NativeUsage = {
    inputTokens: u.promptTokenCount === undefined ? undefined : u.promptTokenCount - cached,
    outputTokens: u.candidatesTokenCount,
  };
  if (u.cachedContentTokenCount !== undefined) out.cacheReadInputTokens = u.cachedContentTokenCount;
  if (u.thoughtsTokenCount !== undefined) out.reasoningTokens = u.thoughtsTokenCount;
  return out;
}

const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE']);

function blockedError(label: string, reason: string, where: 'prompt' | 'answer'): Vid2ContextError {
  return new Vid2ContextError('upstream', `${label} chat: ${where} blocked (${reason}).`, {
    hint: 'Gemini blocked this content. The chain tries the next rung.',
  });
}

/** Throw when a response chunk says the prompt or answer was blocked. */
export function checkBlocked(label: string, json: GenerateContentResponse): void {
  const block = json.promptFeedback?.blockReason;
  if (block) throw blockedError(label, block, 'prompt');
  const finish = json.candidates?.[0]?.finishReason;
  if (finish && BLOCKED_FINISH.has(finish)) throw blockedError(label, finish, 'answer');
}

function unfence(text: string): string {
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return m?.[1] ?? text;
}

export function finishGemini(
  label: string,
  req: ChatRequest,
  text: string,
  model: string,
  finishReason: string | undefined,
  usage: NativeUsage | undefined,
): NativeChatResult {
  let answer = text.trim();
  if (!answer) {
    throw new Vid2ContextError(
      'upstream',
      `${label} chat: empty answer${finishReason ? ` (finishReason ${finishReason})` : ''}.`,
      {
        hint:
          finishReason === 'MAX_TOKENS' ? 'The model used its whole token budget (thinking counts); raise maxTokens.' : undefined,
      },
    );
  }
  if (req.json) {
    answer = unfence(answer).trim();
    if (tryJson(answer) === undefined) {
      throw new Vid2ContextError(
        'upstream',
        `${label} chat: the answer is not valid JSON${finishReason === 'MAX_TOKENS' ? ' (cut off at MAX_TOKENS)' : ''}.`,
        {
          hint: finishReason === 'MAX_TOKENS' ? 'Raise maxTokens so the JSON can finish.' : 'The chain tries the next rung.',
        },
      );
    }
  }
  return { text: answer, model, usage, ...(finishReason ? { stopReason: finishReason } : {}) };
}

function partsOf(json: GenerateContentResponse): Part[] {
  return json.candidates?.[0]?.content?.parts ?? [];
}

export function parseGeminiResponse(
  label: string,
  req: ChatRequest,
  json: GenerateContentResponse,
  fallbackModel: string,
): NativeChatResult {
  checkBlocked(label, json);
  const text = partsOf(json)
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
  return finishGemini(
    label,
    req,
    text,
    json.modelVersion ?? fallbackModel,
    json.candidates?.[0]?.finishReason,
    mapGeminiUsage(json.usageMetadata),
  );
}

// ---------------------------------------------------------------- calls

export async function geminiChat(target: GeminiTarget, req: ChatRequest, ctx: Ctx): Promise<NativeChatResult> {
  const res = await fetchWithTimeout(
    ctx,
    target.url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await target.headers(ctx)) },
      body: JSON.stringify(buildGeminiBody(req)),
    },
    target.timeoutMs ?? 300_000,
  );
  if (!res.ok) throw await googleError(res, target);
  return parseGeminiResponse(target.label, req, (await res.json()) as GenerateContentResponse, target.model);
}

/** Each SSE event is one GenerateContentResponse chunk; parts flagged `thought` become `reasoning`. */
export async function* geminiEvents(
  label: string,
  req: ChatRequest,
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  let text = '';
  let model = fallbackModel;
  let finishReason: string | undefined;
  let usage: NativeUsage | undefined;
  let chunks = 0;
  for await (const msg of parseSSE(body, signal)) {
    const json = tryJson<GenerateContentResponse & GoogleErrorBody>(msg.data);
    if (!json) continue;
    if (json.error) {
      throw new Vid2ContextError(
        'upstream',
        `${label} stream: ${json.error.status ?? json.error.code ?? 'error'}: ${json.error.message ?? ''}`,
      );
    }
    chunks++;
    checkBlocked(label, json);
    model = json.modelVersion ?? model;
    finishReason = json.candidates?.[0]?.finishReason ?? finishReason;
    if (json.usageMetadata) usage = mapGeminiUsage(json.usageMetadata);
    for (const p of partsOf(json)) {
      if (!p.text) continue;
      if (p.thought) {
        yield { type: 'reasoning', text: p.text };
      } else {
        text += p.text;
        yield { type: 'delta', text: p.text };
      }
    }
  }
  if (chunks === 0) throw new Vid2ContextError('upstream', `${label} stream: no chunks received.`);
  yield { type: 'done', result: finishGemini(label, req, text, model, finishReason, usage) };
}

export async function* geminiStream(target: GeminiTarget, req: ChatRequest, ctx: Ctx): AsyncGenerator<ChatStreamEvent> {
  const res = await fetchWithTimeout(
    ctx,
    target.streamUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(await target.headers(ctx)) },
      body: JSON.stringify(buildGeminiBody(req, { stream: true })),
    },
    target.timeoutMs ?? 600_000,
  );
  if (!res.ok) throw await googleError(res, target);
  if (!res.body) throw new Vid2ContextError('upstream', `${target.label} stream: response has no body.`);
  yield* geminiEvents(target.label, req, res.body, target.model, ctx.signal);
}
