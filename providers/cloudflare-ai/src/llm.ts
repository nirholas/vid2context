/**
 * Workers AI chat through the AI binding. Current text models answer in the
 * OpenAI shape (choices[0].message.content) and also mirror the answer in
 * `response`, which JSON mode returns already parsed (an object, not a string).
 * Reasoning models (gpt-oss) put their chain of thought in message.reasoning;
 * only the answer is returned.
 *
 * Streaming (stream: true) yields SSE chunks in the OpenAI chunk shape with a
 * final { response, usage } chunk, then [DONE].
 */
import type { ChatRequest, ChatResult, ChatStreamEvent, Ctx } from '@vid2context/core';
import { Vid2ContextError } from '@vid2context/core';
import { runModel, runModelStream, type Transport } from './transport.ts';

/** Workers AI defaults max_tokens to 256, too small for briefs; ask for this much unless the caller says otherwise. */
export const DEFAULT_MAX_TOKENS = 4096;

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatOutput {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  response?: unknown;
  usage?: Usage;
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }[];
  response?: unknown;
  usage?: Usage;
}

export function buildChatInput(req: ChatRequest, json: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: req.messages,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.json && json) body.response_format = { type: 'json_object' };
  return body;
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** The answer text from either output shape. */
export function answerText(out: ChatOutput): string {
  const content = out.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return stripThink(content);
  if (typeof out.response === 'string') return stripThink(out.response);
  if (out.response !== undefined && out.response !== null) return JSON.stringify(out.response);
  return '';
}

function usageOf(u: Usage | undefined): ChatResult['usage'] {
  return u ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens } : undefined;
}

export async function chat(
  t: Transport,
  model: string,
  json: boolean,
  req: ChatRequest,
  ctx: Ctx,
  label: string,
): Promise<ChatResult> {
  const out = (await runModel(ctx, t, model, { json: buildChatInput(req, json) }, { label, timeoutMs: 300_000 })) as ChatOutput;
  const text = answerText(out);
  if (!text) {
    const reason = out.choices?.[0]?.finish_reason;
    throw new Vid2ContextError('upstream', `${label}: empty answer${reason ? ` (finish_reason ${reason})` : ''}.`, {
      hint: reason === 'length' ? 'The model spent its token budget on reasoning; raise maxTokens.' : undefined,
    });
  }
  return { text, model, usage: usageOf(out.usage) };
}

/** Parse a Workers AI SSE byte stream into chat stream events. */
export async function* parseSse(stream: ReadableStream<Uint8Array>, model: string): AsyncIterable<ChatStreamEvent> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let text = '';
  let usage: Usage | undefined;
  const handle = function* (line: string): Generator<ChatStreamEvent> {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      return;
    }
    // Per-token chunks report 0 prompt tokens; the first chunk has the prompt count, the final one both.
    const u = chunk.usage;
    if (u?.prompt_tokens && (u.completion_tokens || !usage)) usage = u;
    if (Array.isArray(chunk.choices)) {
      const delta = chunk.choices[0]?.delta;
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) yield { type: 'reasoning', text: reasoning };
      if (delta?.content) {
        text += delta.content;
        yield { type: 'delta', text: delta.content };
      }
      return;
    }
    // Older models stream only { response }. The final summary chunk has an empty response.
    if (chunk.response !== undefined && chunk.response !== null && chunk.response !== '') {
      const piece = String(chunk.response);
      text += piece;
      yield { type: 'delta', text: piece };
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        yield* handle(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    }
    if (buf) yield* handle(buf);
  } finally {
    reader.releaseLock();
  }
  yield { type: 'done', result: { text: stripThink(text), model, usage: usageOf(usage) } };
}

export async function* streamChat(
  t: Transport,
  model: string,
  json: boolean,
  req: ChatRequest,
  ctx: Ctx,
  label: string,
): AsyncIterable<ChatStreamEvent> {
  const stream = await runModelStream(ctx, t, model, buildChatInput(req, json), { label });
  yield* parseSse(stream, model);
}
