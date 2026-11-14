/**
 * OpenAI-compatible local servers (LM Studio, llama.cpp, vLLM, Jan, LocalAI,
 * anything else). Non-streaming chat reuses the foundation's `chatWith`;
 * streaming uses the shared `streamOpenAiChat` from packages/core with the
 * same request body.
 *
 * Servers that refuse an over-long prompt say so in a 400 (llama.cpp:
 * `exceed_context_size_error`; vLLM: "maximum context length"); that becomes
 * `too-large` with a hint instead of a generic upstream error.
 */
import { type ChatRequest, type ChatResult, type ChatStreamEvent, type Ctx, streamOpenAiChat, Vid2ContextError } from '@vid2context/core';
import { buildBody, type ChatEndpoint, chatWith } from '@vid2context/provider-llm-openai-compatible';

const OVERFLOW = /exceed_context_size_error|exceeds the available context size|maximum context length/i;

function overflow(err: Vid2ContextError, label: string): Vid2ContextError {
  return new Vid2ContextError('too-large', err.message, {
    status: err.status,
    cause: err,
    hint: `The prompt does not fit the context window ${label} was started with. Restart it with a larger context (llama.cpp: -c 32768; vLLM: --max-model-len), load a model with a longer context, or ask about a shorter part of the video.`,
  });
}

function mapError(err: unknown, label: string): unknown {
  if (err instanceof Vid2ContextError && err.status === 400 && OVERFLOW.test(err.message)) return overflow(err, label);
  return err;
}

export async function openAiChat(ep: ChatEndpoint, req: ChatRequest, ctx: Ctx): Promise<ChatResult> {
  try {
    return await chatWith(ep, req, ctx);
  } catch (err) {
    throw mapError(err, ep.label);
  }
}

/** Stream chat completions over SSE with the shared core client, mapping context overflows to `too-large`. */
export async function* openAiStream(ep: ChatEndpoint, req: ChatRequest, ctx: Ctx): AsyncIterable<ChatStreamEvent> {
  const stream = streamOpenAiChat(
    {
      url: ep.url,
      model: ep.model,
      key: ep.key,
      label: ep.label,
      // The same body the non-streaming client sends (JSON mode, schema, max_tokens).
      body: (r) => buildBody(ep, r),
      idleTimeoutMs: ep.timeoutMs ?? 300_000,
    },
    req,
    ctx,
  );
  try {
    yield* stream;
  } catch (err) {
    throw mapError(err, ep.label);
  }
}
