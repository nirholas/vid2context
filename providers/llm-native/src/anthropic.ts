/**
 * Client for the Anthropic Messages API, used for both api.anthropic.com and
 * Claude on Vertex AI (rawPredict / streamRawPredict take the same body with
 * `anthropic_version` instead of `model`). Plain fetch, runtime-neutral.
 *
 * Prompt caching: long stable content (system instructions plus transcripts,
 * earlier turns, the material before the final question) is marked with
 * `cache_control: { type: 'ephemeral' }`, so ten questions about the same
 * playlist pay full price for the transcript once and about a tenth of it
 * after that. The question itself is never inside a cached block.
 *
 * JSON: a schema goes into `output_config.format` (structured outputs). A
 * forced single tool would also work on older models, but Claude Sonnet 5.5
 * and Opus 5.5 reject forced `tool_choice` with a 400, and structured outputs
 * work on every current model.
 */
import {
  type ChatMessage,
  type ChatRequest,
  type ChatStreamEvent,
  type Ctx,
  estimateTokens,
  fetchWithTimeout,
  parseSSE,
  Vid2ContextError,
} from '@vid2context/core';
import { type NativeChatResult, type NativeUsage, secondsUntil, tryJson } from './common.ts';

/** API version header (and Vertex body field). 2026-10-21 drops temperature, top_p and top_k from Messages requests. */
export const ANTHROPIC_VERSION = '2026-10-21';

const JSON_INSTRUCTION = 'Reply with a single JSON object and nothing else.';

export interface AnthropicTarget {
  /** Service name, used in error messages ('anthropic', 'anthropic#2', 'vertex-anthropic'). */
  label: string;
  model: string;
  /** 'api' sends `model` in the body; 'vertex' sends `anthropic_version` instead. */
  flavor: 'api' | 'vertex';
  url: string;
  /** Vertex streams from a different URL (streamRawPredict); the API streams from the same URL. */
  streamUrl: string;
  /** Auth and version headers for one call. */
  headers(ctx: Ctx): Promise<Record<string, string>>;
  /** Hint shown on 401 and 403. */
  authHint: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------- caching

/**
 * Smallest prefix each model will cache; shorter prefixes are silently not
 * cached. From Anthropic's prompt caching reference (2026-11).
 */
export function minCacheTokens(model: string): number {
  const m = model.toLowerCase();
  if (/(opus|sonnet|haiku)-5-5|opus-5(?!-\d)|fable|mythos/.test(m)) return 512;
  if (/haiku-4-5|opus-4-[56]/.test(m)) return 4096;
  if (/opus-4-7/.test(m)) return 2048;
  return 1024;
}

interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface WireMessage {
  role: 'user' | 'assistant';
  content: TextBlock[];
}

const EPHEMERAL = { type: 'ephemeral' } as const;

/**
 * System text plus messages with cache breakpoints placed so the stable
 * prefix is cached and the final question is not. At most three of the four
 * allowed breakpoints are used:
 *   1. the system block, when it alone is long enough;
 *   2. the turn before the final message, when everything up to it is long enough (multi-turn chats);
 *   3. the final user message split at its last blank line, when the material before the question is long enough.
 */
export function buildMessages(
  messages: ChatMessage[],
  model: string,
  extraSystem?: string,
): { system?: TextBlock[]; messages: WireMessage[] } {
  const min = minCacheTokens(model);
  const systemText = [...messages.filter((m) => m.role === 'system').map((m) => m.content), ...(extraSystem ? [extraSystem] : [])]
    .filter((t) => t.trim())
    .join('\n\n');
  const turns: WireMessage[] = messages
    .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system' && m.content.trim() !== '')
    .map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] }));

  let prefixTokens = 0;
  let system: TextBlock[] | undefined;
  if (systemText) {
    prefixTokens = estimateTokens(systemText);
    system = [{ type: 'text', text: systemText, ...(prefixTokens >= min ? { cache_control: EPHEMERAL } : {}) }];
  }

  const last = turns.length - 1;
  for (let i = 0; i < last; i++) prefixTokens += estimateTokens(turns[i]?.content[0]?.text ?? '');
  const beforeLast = turns[last - 1];
  if (beforeLast && prefixTokens >= min) {
    const block = beforeLast.content[0];
    if (block) block.cache_control = EPHEMERAL;
  }

  const final = turns[last];
  const finalText = final?.content[0]?.text ?? '';
  if (final && final.role === 'user') {
    const cut = finalText.lastIndexOf('\n\n');
    const head = cut > 0 ? finalText.slice(0, cut) : '';
    const tail = cut > 0 ? finalText.slice(cut + 2) : '';
    if (head.trim() && tail.trim() && prefixTokens + estimateTokens(head) >= min && estimateTokens(head) >= min / 2) {
      final.content = [
        { type: 'text', text: head, cache_control: EPHEMERAL },
        { type: 'text', text: tail },
      ];
    }
  }
  return { system, messages: turns };
}

// ---------------------------------------------------------------- JSON Schema

const DROP_KEYS = new Set([
  '$schema',
  '$id',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'contains',
  'minContains',
  'maxContains',
]);

/**
 * Fit a JSON Schema to Anthropic structured outputs: every object gets
 * `additionalProperties: false` (required), and the numeric, string-length
 * and complex array constraints the API rejects are dropped (validate those
 * in code). `minItems` is kept only as 0 or 1.
 */
export function anthropicSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(anthropicSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === 'minItems') {
      if (v === 0 || v === 1) out[k] = v;
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, anthropicSchema(s)]));
      continue;
    }
    if (k === '$defs' || k === 'definitions') {
      out[k] = Object.fromEntries(Object.entries((v ?? {}) as Record<string, unknown>).map(([p, s]) => [p, anthropicSchema(s)]));
      continue;
    }
    if (k === 'additionalProperties') continue;
    out[k] = anthropicSchema(v);
  }
  const type = out.type;
  if (type === 'object' || (Array.isArray(type) && type.includes('object')) || out.properties) out.additionalProperties = false;
  return out;
}

// ---------------------------------------------------------------- request

/** Thinking is on by default on Claude 5-generation models; streaming asks for readable summaries so the UI can show reasoning. */
function thinkingOnByDefault(model: string): boolean {
  return /claude-(opus|sonnet|haiku)-5|claude-(fable|mythos)/.test(model.toLowerCase());
}

export function buildAnthropicBody(
  target: Pick<AnthropicTarget, 'model' | 'flavor'>,
  req: ChatRequest,
  opts: { stream?: boolean } = {},
): Record<string, unknown> {
  const schema = typeof req.json === 'object' ? req.json.schema : undefined;
  const extraSystem = req.json && !schema ? JSON_INSTRUCTION : undefined;
  const { system, messages } = buildMessages(req.messages, target.model, extraSystem);
  const body: Record<string, unknown> = {};
  if (target.flavor === 'api') body.model = target.model;
  else body.anthropic_version = ANTHROPIC_VERSION;
  body.max_tokens = req.maxTokens ?? 16_000;
  if (system) body.system = system;
  body.messages = messages;
  // temperature is not sent: API version 2026-10-21 rejects sampling parameters on every model.
  if (schema) body.output_config = { format: { type: 'json_schema', schema: anthropicSchema(schema) } };
  if (opts.stream) {
    body.stream = true;
    if (thinkingOnByDefault(target.model)) body.thinking = { type: 'adaptive', display: 'summarized' };
  }
  return body;
}

// ---------------------------------------------------------------- errors

interface AnthropicErrorBody {
  type?: string;
  error?: { type?: string; message?: string; code?: number; status?: string };
}

const RESET_HEADERS = [
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-reset',
];

/** Seconds to wait from Retry-After, else the latest anthropic-ratelimit-*-reset timestamp. */
export function anthropicRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const ra = Number(headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.ceil(ra);
  let best: number | undefined;
  for (const h of RESET_HEADERS) {
    const s = secondsUntil(headers.get(h), now);
    if (s !== undefined && (best === undefined || s > best)) best = s;
  }
  return best;
}

/**
 * Map a non-2xx Messages response. Bodies are Anthropic's
 * `{ type: 'error', error: { type, message } }`, or Google's
 * `{ error: { code, message, status } }` when Vertex rejects the call first.
 */
export async function anthropicError(res: Response, target: Pick<AnthropicTarget, 'label' | 'authHint'>): Promise<Vid2ContextError> {
  const raw = await res.text().catch(() => '');
  const parsed = tryJson<AnthropicErrorBody>(raw);
  const detail = parsed?.error?.message ?? raw.slice(0, 500);
  const kind = parsed?.error?.type ?? parsed?.error?.status;
  const s = res.status;
  const msg = `${target.label} chat: HTTP ${s}${kind ? ` ${kind}` : ''}${detail ? `: ${detail}` : ''}`;
  if (s === 429) {
    return new Vid2ContextError('rate-limited', msg, {
      status: s,
      retryAfterSec: anthropicRetryAfter(res.headers),
      hint: 'Rate limited. The chain moves to the next rung and retries this one after the reset time.',
    });
  }
  if (s === 529) {
    return new Vid2ContextError('upstream', msg, {
      status: s,
      retryAfterSec: 30,
      hint: 'Anthropic is overloaded. The chain moves on and retries this rung after about 30 seconds.',
    });
  }
  if (s === 401 || s === 403) return new Vid2ContextError('auth', msg, { status: s, hint: target.authHint });
  if (s === 400 && /credit balance/i.test(detail)) {
    return new Vid2ContextError('auth', msg, { status: s, hint: 'The Anthropic account is out of credits. Add credits in the Claude Console.' });
  }
  if (s === 404) return new Vid2ContextError('not-found', msg, { status: s, hint: 'The model id is unknown or retired. Set a current id in the model env var.' });
  if (s === 413) return new Vid2ContextError('too-large', msg, { status: s });
  return new Vid2ContextError('upstream', msg, { status: s });
}

// ---------------------------------------------------------------- responses

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface WireMessageResponse {
  model?: string;
  content?: { type: string; text?: string; thinking?: string }[];
  stop_reason?: string | null;
  usage?: WireUsage;
}

export function mapAnthropicUsage(u: WireUsage | undefined): NativeUsage | undefined {
  if (!u) return undefined;
  const out: NativeUsage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
  if (u.cache_creation_input_tokens !== undefined) out.cacheCreationInputTokens = u.cache_creation_input_tokens;
  if (u.cache_read_input_tokens !== undefined) out.cacheReadInputTokens = u.cache_read_input_tokens;
  return out;
}

/** Remove a ```json fence some answers wrap around JSON. */
function unfence(text: string): string {
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return m?.[1] ?? text;
}

/** Validate and finish a result: refusals, empty answers and invalid JSON become errors so the chain falls through. */
export function finishAnthropic(
  label: string,
  req: ChatRequest,
  text: string,
  model: string,
  stopReason: string | undefined,
  usage: NativeUsage | undefined,
): NativeChatResult {
  if (stopReason === 'refusal') {
    throw new Vid2ContextError('upstream', `${label} chat: the model declined the request (stop_reason refusal).`, {
      hint: 'A safety classifier declined this request. The chain tries the next rung.',
    });
  }
  let answer = text.trim();
  if (!answer) {
    throw new Vid2ContextError('upstream', `${label} chat: empty answer${stopReason ? ` (stop_reason ${stopReason})` : ''}.`, {
      hint: stopReason === 'max_tokens' ? 'The model used its whole token budget; raise maxTokens.' : undefined,
    });
  }
  if (req.json) {
    answer = unfence(answer).trim();
    if (tryJson(answer) === undefined) {
      throw new Vid2ContextError('upstream', `${label} chat: the answer is not valid JSON${stopReason === 'max_tokens' ? ' (cut off at max_tokens)' : ''}.`, {
        hint: stopReason === 'max_tokens' ? 'Raise maxTokens so the JSON can finish.' : 'The chain tries the next rung.',
      });
    }
  }
  return { text: answer, model, usage, ...(stopReason ? { stopReason } : {}) };
}

export function parseAnthropicMessage(label: string, req: ChatRequest, json: WireMessageResponse, fallbackModel: string): NativeChatResult {
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return finishAnthropic(label, req, text, json.model ?? fallbackModel, json.stop_reason ?? undefined, mapAnthropicUsage(json.usage));
}

// ---------------------------------------------------------------- calls

export async function anthropicChat(target: AnthropicTarget, req: ChatRequest, ctx: Ctx): Promise<NativeChatResult> {
  const res = await fetchWithTimeout(
    ctx,
    target.url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await target.headers(ctx)) },
      body: JSON.stringify(buildAnthropicBody(target, req)),
    },
    target.timeoutMs ?? 300_000,
  );
  if (!res.ok) throw await anthropicError(res, target);
  return parseAnthropicMessage(target.label, req, (await res.json()) as WireMessageResponse, target.model);
}

interface StreamEventData {
  type?: string;
  message?: WireMessageResponse;
  content_block?: { type?: string; text?: string; thinking?: string };
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string | null };
  usage?: WireUsage;
  error?: { type?: string; message?: string };
}

/**
 * Turn a Messages SSE body into ChatStreamEvents. Text deltas become `delta`,
 * thinking deltas `reasoning`; `ping`, signatures and tool-input deltas are
 * ignored; an `error` event throws.
 */
export async function* anthropicEvents(
  label: string,
  req: ChatRequest,
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  let model = fallbackModel;
  let text = '';
  let stopReason: string | undefined;
  const usage: WireUsage = {};
  const merge = (u: WireUsage | undefined) => {
    if (!u) return;
    for (const [k, v] of Object.entries(u)) if (typeof v === 'number') (usage as Record<string, number>)[k] = v;
  };
  let stopped = false;
  for await (const msg of parseSSE(body, signal)) {
    const data = tryJson<StreamEventData>(msg.data);
    if (!data) continue;
    const type = data.type ?? msg.event;
    if (type === 'message_start') {
      model = data.message?.model ?? model;
      merge(data.message?.usage);
    } else if (type === 'content_block_start') {
      const b = data.content_block;
      if (b?.type === 'text' && b.text) {
        text += b.text;
        yield { type: 'delta', text: b.text };
      } else if (b?.type === 'thinking' && b.thinking) {
        yield { type: 'reasoning', text: b.thinking };
      }
    } else if (type === 'content_block_delta') {
      const d = data.delta;
      if (d?.type === 'text_delta' && d.text) {
        text += d.text;
        yield { type: 'delta', text: d.text };
      } else if (d?.type === 'thinking_delta' && d.thinking) {
        yield { type: 'reasoning', text: d.thinking };
      }
    } else if (type === 'message_delta') {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      merge(data.usage);
    } else if (type === 'message_stop') {
      stopped = true;
      break;
    } else if (type === 'error') {
      const overloaded = data.error?.type === 'overloaded_error';
      throw new Vid2ContextError('upstream', `${label} stream: ${data.error?.type ?? 'error'}: ${data.error?.message ?? msg.data}`, {
        status: overloaded ? 529 : undefined,
        retryAfterSec: overloaded ? 30 : undefined,
        hint: overloaded ? 'Anthropic is overloaded. The chain moves on and retries this rung after about 30 seconds.' : undefined,
      });
    }
  }
  if (!stopped && !stopReason) throw new Vid2ContextError('upstream', `${label} stream: ended before message_stop.`);
  yield { type: 'done', result: finishAnthropic(label, req, text, model, stopReason, mapAnthropicUsage(usage)) };
}

export async function* anthropicStream(target: AnthropicTarget, req: ChatRequest, ctx: Ctx): AsyncGenerator<ChatStreamEvent> {
  const res = await fetchWithTimeout(
    ctx,
    target.streamUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(await target.headers(ctx)) },
      body: JSON.stringify(buildAnthropicBody(target, req, { stream: true })),
    },
    target.timeoutMs ?? 600_000,
  );
  if (!res.ok) throw await anthropicError(res, target);
  if (!res.body) throw new Vid2ContextError('upstream', `${target.label} stream: response has no body.`);
  yield* anthropicEvents(target.label, req, res.body, target.model, ctx.signal);
}
