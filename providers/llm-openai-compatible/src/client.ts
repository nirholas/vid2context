/**
 * Client for OpenAI-compatible POST /chat/completions. Plain fetch, so it runs
 * on Node, Workers and in the browser. Reasoning models (gpt-oss, Qwen3,
 * Nemotron) return their chain of thought in a separate `reasoning` field or
 * inline <think> blocks; only the answer is returned. An empty answer is an
 * error, so the chain moves on to the next rung.
 */
import {
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type Ctx,
  errorFromResponse,
  fetchWithTimeout,
  Vid2ContextError,
} from '@vid2context/core';

export interface ChatEndpoint {
  /** Full chat completions URL. */
  url: string;
  model: string;
  /** Omitted for keyless endpoints: they reject a bogus Authorization header. */
  key?: string;
  label: string;
  /** The endpoint honours response_format json_schema (strict structured output). */
  jsonSchema?: boolean;
  /** Extra body fields the lane needs. */
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
}

const JSON_INSTRUCTION = 'Reply with a single JSON object and nothing else.';

function withJsonInstruction(messages: ChatMessage[], schema?: Record<string, unknown>): ChatMessage[] {
  const instruction = schema ? `${JSON_INSTRUCTION} It must match this JSON Schema:\n${JSON.stringify(schema)}` : JSON_INSTRUCTION;
  const sys = messages.findIndex((m) => m.role === 'system');
  if (sys === -1) return [{ role: 'system', content: instruction }, ...messages];
  return messages.map((m, i) => (i === sys ? { ...m, content: `${m.content}\n\n${instruction}` } : m));
}

export function buildBody(ep: ChatEndpoint, req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: ep.model, messages: req.messages, ...(ep.extraBody ?? {}) };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.json) {
    const schema = typeof req.json === 'object' ? req.json.schema : undefined;
    if (schema && ep.jsonSchema) {
      const name = (typeof req.json === 'object' && req.json.name) || 'result';
      body.response_format = { type: 'json_schema', json_schema: { name, schema, strict: true } };
      body.messages = withJsonInstruction(req.messages);
    } else {
      body.response_format = { type: 'json_object' };
      body.messages = withJsonInstruction(req.messages, schema);
    }
  }
  return body;
}

interface CompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | { type?: string; text?: string }[] | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The answer text: content parts joined, inline <think> blocks removed. */
export function answerText(res: CompletionResponse): string {
  const content = res.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p.text ?? '').join('') : '';
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export async function chatWith(ep: ChatEndpoint, req: ChatRequest, ctx: Ctx): Promise<ChatResult> {
  const res = await fetchWithTimeout(
    ctx,
    ep.url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ep.key ? { authorization: `Bearer ${ep.key}` } : {}) },
      body: JSON.stringify(buildBody(ep, req)),
    },
    ep.timeoutMs ?? 120_000,
  );
  if (!res.ok) throw await errorFromResponse(res, `${ep.label} chat`);
  const json = (await res.json()) as CompletionResponse;
  const text = answerText(json);
  if (!text) {
    const reason = json.choices?.[0]?.finish_reason;
    throw new Vid2ContextError('upstream', `${ep.label} chat: empty answer${reason ? ` (finish_reason ${reason})` : ''}.`, {
      hint: reason === 'length' ? 'The model spent its token budget on reasoning; raise maxTokens.' : undefined,
    });
  }
  return {
    text,
    model: json.model ?? ep.model,
    usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
  };
}
