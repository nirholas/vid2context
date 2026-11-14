/**
 * Streaming client for OpenAI-compatible POST /chat/completions with
 * `stream: true`. Plain fetch through ctx, so it runs on Node, Workers and in
 * the browser. Yields `delta` for answer text, `reasoning` for chain of
 * thought (`delta.reasoning_content`, `delta.reasoning`, or inline <think>
 * blocks), then exactly one `done` with the full answer, model and usage.
 */
import { errorFromResponse, Vid2ContextError } from '../errors.ts';
import type { ChatStreamEvent } from '../llm-stream.ts';
import type { ChatRequest } from '../provider.ts';
import type { Ctx } from '../types.ts';
import { parseSSE } from './sse.ts';

export interface StreamEndpoint {
  /** Full chat completions URL. */
  url: string;
  model: string;
  /** Omitted for keyless endpoints. */
  key?: string;
  headers?: Record<string, string>;
  /** Name used in error messages, e.g. 'ovh'. Default: the URL host. */
  label?: string;
  /**
   * Builds the request body without the streaming fields. Providers pass the
   * builder their non-streaming client uses, so both send the same body.
   * Default: model, messages, max_tokens, temperature and json_object mode.
   */
  body?: (req: ChatRequest) => Record<string, unknown>;
  /** The service rejects `stream_options`; skip it from the start. */
  noStreamOptions?: boolean;
  /** Time allowed until the response headers arrive, and between chunks after that. Default 120000. */
  idleTimeoutMs?: number;
}

/** stream_options rejection, remembered per URL so later calls skip the retry. */
const rejectsStreamOptions = new Set<string>();

function defaultBody(ep: StreamEndpoint, req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: ep.model, messages: req.messages };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.json) body.response_format = { type: 'json_object' };
  return body;
}

interface StreamChunk {
  model?: string;
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; code?: string | number; type?: string; status?: number } | string;
}

function labelOf(ep: StreamEndpoint): string {
  if (ep.label) return ep.label;
  try {
    return new URL(ep.url).host;
  } catch {
    return 'llm';
  }
}

/** Turn an error object sent inside the stream into a Vid2ContextError. */
function streamError(label: string, err: NonNullable<StreamChunk['error']>): Vid2ContextError {
  const obj = typeof err === 'string' ? { message: err } : err;
  const status = typeof obj.status === 'number' ? obj.status : typeof obj.code === 'number' ? obj.code : undefined;
  const tag = `${obj.code ?? ''} ${obj.type ?? ''}`.toLowerCase();
  const msg = `${label} chat stream: ${obj.message ?? 'error'}`.slice(0, 500);
  if (status === 429 || tag.includes('rate') || tag.includes('quota')) {
    return new Vid2ContextError('rate-limited', msg, { status });
  }
  if (status === 401 || status === 403 || tag.includes('auth')) return new Vid2ContextError('auth', msg, { status });
  return new Vid2ContextError('upstream', msg, {
    status,
    hint: 'The service ended the stream with an error; try again or pick another model.',
  });
}

/**
 * Routes inline <think>...</think> text to reasoning. Tags may be split
 * across chunks, so a partial tag at the end of a chunk is held back.
 */
class ThinkSplitter {
  private inThink = false;
  private pending = '';

  push(text: string): { delta: string; reasoning: string } {
    let s = this.pending + text;
    this.pending = '';
    let delta = '';
    let reasoning = '';
    while (s.length > 0) {
      const tag = this.inThink ? '</think>' : '<think>';
      const at = s.indexOf(tag);
      if (at !== -1) {
        if (this.inThink) reasoning += s.slice(0, at);
        else delta += s.slice(0, at);
        s = s.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // Hold back a suffix that could be the start of the tag.
      let keep = 0;
      for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
        if (tag.startsWith(s.slice(s.length - n))) {
          keep = n;
          break;
        }
      }
      const out = s.slice(0, s.length - keep);
      if (this.inThink) reasoning += out;
      else delta += out;
      this.pending = s.slice(s.length - keep);
      s = '';
    }
    return { delta, reasoning };
  }

  flush(): { delta: string; reasoning: string } {
    const rest = this.pending;
    this.pending = '';
    return this.inThink ? { delta: '', reasoning: rest } : { delta: rest, reasoning: '' };
  }
}

async function open(ep: StreamEndpoint, req: ChatRequest, ctx: Ctx, controller: AbortController): Promise<Response> {
  const label = labelOf(ep);
  const base = ep.body ? ep.body(req) : defaultBody(ep, req);
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(ep.key ? { authorization: `Bearer ${ep.key}` } : {}),
    ...(ep.headers ?? {}),
  };
  const send = (withOptions: boolean) =>
    ctx.fetch(ep.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...base, stream: true, ...(withOptions ? { stream_options: { include_usage: true } } : {}) }),
      signal: controller.signal,
    });
  const withOptions = !ep.noStreamOptions && !rejectsStreamOptions.has(ep.url);
  let res = await send(withOptions);
  if (res.status === 400 && withOptions) {
    const text = await res
      .clone()
      .text()
      .catch(() => '');
    if (text.includes('stream_options')) {
      rejectsStreamOptions.add(ep.url);
      ctx.log.debug('chat stream: service rejects stream_options, retrying without', { label });
      res = await send(false);
    }
  }
  if (!res.ok) throw await errorFromResponse(res, `${label} chat stream`);
  if (!res.body) throw new Vid2ContextError('upstream', `${label} chat stream: empty response body.`);
  return res;
}

/** Stream one chat completion from an OpenAI-compatible endpoint. */
export async function* streamOpenAiChat(ep: StreamEndpoint, req: ChatRequest, ctx: Ctx): AsyncGenerator<ChatStreamEvent> {
  const label = labelOf(ep);
  const idleMs = ep.idleTimeoutMs ?? 120_000;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(`${label} chat stream timed out`, 'TimeoutError'));
    }, idleMs);
  };
  const onAbort = () => controller.abort(ctx.signal?.reason);
  if (ctx.signal?.aborted) onAbort();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });

  let text = '';
  let model = ep.model;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let finish: string | undefined;
  let sawDone = false;
  const think = new ThinkSplitter();

  // Leading whitespace before any visible text is dropped, like the non-streaming client's trim.
  function* emit(part: { delta: string; reasoning: string }): Generator<ChatStreamEvent> {
    if (part.reasoning) yield { type: 'reasoning', text: part.reasoning };
    const d = text === '' ? part.delta.replace(/^\s+/, '') : part.delta;
    if (d) {
      text += d;
      yield { type: 'delta', text: d };
    }
  }

  try {
    arm();
    let res: Response;
    try {
      res = await open(ep, req, ctx, controller);
    } catch (err) {
      if (timedOut) throw new Vid2ContextError('timeout', `${label} chat stream: no response in ${idleMs} ms.`, { cause: err });
      throw err;
    }
    try {
      for await (const msg of parseSSE(res.body as ReadableStream<Uint8Array>, controller.signal)) {
        arm();
        const data = msg.data.trim();
        if (data === '[DONE]') {
          sawDone = true;
          break;
        }
        if (data === '') continue;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          if (msg.event === 'error') throw streamError(label, data);
          ctx.log.debug('chat stream: skipped a non-JSON event', { label });
          continue;
        }
        if (chunk.error) throw streamError(label, chunk.error);
        if (msg.event === 'error') throw streamError(label, data);
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta;
        if (!d) continue;
        const reasoning = d.reasoning_content || d.reasoning;
        if (reasoning) yield { type: 'reasoning', text: reasoning };
        if (d.content) yield* emit(think.push(d.content));
      }
    } catch (err) {
      if (timedOut) throw new Vid2ContextError('timeout', `${label} chat stream: no data for ${idleMs} ms.`, { cause: err });
      throw err;
    }
    // A body that stops with neither [DONE] nor a finish_reason was cut off (connection dropped).
    if (!sawDone && !finish) {
      throw new Vid2ContextError('upstream', `${label} chat stream: the connection closed before the answer finished.`, {
        hint: 'Try again; if it keeps happening, pick another model.',
      });
    }
    yield* emit(think.flush());
    if (!text) {
      throw new Vid2ContextError('upstream', `${label} chat stream: empty answer${finish ? ` (finish_reason ${finish})` : ''}.`, {
        hint: finish === 'length' ? 'The model spent its token budget on reasoning; raise maxTokens.' : undefined,
      });
    }
    yield { type: 'done', result: { text, model, ...(usage ? { usage } : {}) } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}
