/**
 * HTTP routes for asking, as a Hono sub-app. Item 46 (or the integration
 * pass) mounts it: `app.route('/api/v1', askRoutes(deps))`.
 *
 *   POST /ask   { question, collectionId?, inputs?, stream?, model?, history? }
 *               JSON AskResult, or text/event-stream when stream is true
 *   POST /chat  ChatApiRequest (docs/prompts/SHARED-CONTRACTS.md section 3), always text/event-stream
 *
 * Errors before streaming starts (bad body, unknown collection, a video that
 * cannot be had) are thrown as Vid2ContextError, so the main app's onError
 * answers with the standard error body and status. Errors after streaming
 * starts are sent as an `error` event. A comment line goes out every 15
 * seconds so proxies keep the connection open, and a client disconnect
 * aborts the upstream request.
 */
import { type Ctx, MemoryStorage, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ask, prepareAsk, streamAnswer } from './engine.ts';
import type { AskEvent, AskOptions, HistoryMessage, ModelChoice } from './types.ts';

export interface RouteDeps {
  registry: Registry;
  makeCtx: (req: Request) => Ctx;
  /** The library. Omitted or null: the registry's enabled storage provider, else a per-request MemoryStorage. */
  storage?: (ctx: Ctx) => Promise<Storage | null>;
}

export const HEARTBEAT_MS = 15_000;

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

async function readBody(c: Context, example: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw bad('The body must be JSON.', `Send ${example} with Content-Type: application/json.`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The body must be a JSON object.', `Send ${example}.`);
  return body as Record<string, unknown>;
}

function stringList(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string'))
    throw bad(`${name} must be an array of strings.`, `Send ${name} as ["<video URL>", ...].`);
  return v as string[];
}

function optionalString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v) throw bad(`${name} must be a non-empty string.`, `Send ${name} as a string, or leave it out.`);
  return v;
}

function optionalNumber(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw bad(`${name} must be a number from ${min} to ${max}.`, `Send ${name} as a JSON number, or leave it out.`);
  }
  return v;
}

function readModel(v: unknown): ModelChoice | undefined {
  if (v === undefined || v === null) return undefined;
  const m = v as Record<string, unknown>;
  if (typeof m === 'object' && typeof m.rung === 'string' && m.rung) {
    if (m.strict !== undefined && typeof m.strict !== 'boolean')
      throw bad('model.strict must be true or false.', 'Leave it out to fall back along the chain.');
    return { rung: m.rung, strict: m.strict === true };
  }
  if (typeof m === 'object' && (m.policy === 'free' || m.policy === 'quality' || m.policy === 'local-only'))
    return { policy: m.policy };
  throw bad(
    'model must be { rung, strict? } or { policy }.',
    'Use a rung id from GET /api/v1/models, or a policy: free, quality, local-only. Leave model out for Auto.',
  );
}

function readHistory(v: unknown, name: string): HistoryMessage[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad(`${name} must be an array of messages.`, 'Send [{ "role": "user", "content": "..." }, ...].');
  return v.map((m, i) => {
    const msg = m as Record<string, unknown>;
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant') || typeof msg.content !== 'string') {
      throw bad(
        `${name}[${i}] must be { role: "user" | "assistant", content: string }.`,
        'Only user and assistant turns are accepted.',
      );
    }
    return { role: msg.role, content: msg.content };
  });
}

/** The SSE `data` of an event: the event without its `type`. */
export function eventData(ev: AskEvent): Record<string, unknown> {
  const { type: _type, ...data } = ev;
  return data;
}

export function askRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  /** One Ctx per request whose signal also fires when the SSE client goes away. */
  const open = async (req: Request) => {
    const controller = new AbortController();
    const base = deps.makeCtx(req);
    const signals = [controller.signal, base.signal, req.signal].filter((s): s is AbortSignal => Boolean(s));
    const ctx: Ctx = { ...base, signal: AbortSignal.any(signals) };
    const fromDeps = deps.storage ? await deps.storage(ctx) : await deps.registry.openStorage(ctx);
    return { ctx, controller, storage: fromDeps ?? new MemoryStorage() };
  };

  const stream = async (c: Context, opts: AskOptions, ctx: Ctx, controller: AbortController) => {
    // Preparation errors throw here, before any byte is sent, and get the standard error body.
    const prepared = await prepareAsk(deps.registry, opts, ctx);
    return streamSSE(c, async (sse) => {
      sse.onAbort(() => controller.abort());
      const beat = setInterval(() => {
        sse.write(': keep-alive\n\n').catch(() => controller.abort());
      }, HEARTBEAT_MS);
      try {
        for await (const ev of streamAnswer(prepared, deps.registry, ctx)) {
          if (sse.aborted || sse.closed) break;
          await sse.writeSSE({ event: ev.type, data: JSON.stringify(eventData(ev)) });
        }
      } catch (err) {
        if (!sse.aborted && !sse.closed) {
          const message = err instanceof Error ? err.message : String(err);
          await sse.writeSSE({ event: 'error', data: JSON.stringify({ code: 'internal', message }) });
        }
      } finally {
        clearInterval(beat);
      }
    });
  };

  app.post('/ask', async (c) => {
    const body = await readBody(c, '{"question": "...", "inputs": ["<video URL>"]}');
    if (typeof body.question !== 'string') throw bad('question must be a string.', 'Send the question as "question".');
    const { ctx, controller, storage } = await open(c.req.raw);
    const collectionId = optionalString(body.collectionId, 'collectionId');
    const opts: AskOptions = {
      question: body.question,
      history: readHistory(body.history, 'history'),
      inputs: stringList(body.inputs, 'inputs'),
      ...(collectionId ? { collectionId } : {}),
      storage,
      model: readModel(body.model),
      maxTokens: optionalNumber(body.maxTokens, 'maxTokens', 64, 16_384),
      temperature: optionalNumber(body.temperature, 'temperature', 0, 2),
    };
    if (body.stream === true) return stream(c, opts, ctx, controller);
    return c.json(await ask(deps.registry, opts, ctx));
  });

  app.post('/chat', async (c) => {
    const body = await readBody(c, '{"messages": [{"role": "user", "content": "..."}], "context": {"inputs": ["<video URL>"]}}');
    const messages = readHistory(body.messages, 'messages');
    const last = messages.at(-1);
    if (last?.role !== 'user')
      throw bad('messages must end with a user message.', 'Send the conversation oldest first, ending with the new question.');
    const context = (body.context ?? {}) as Record<string, unknown>;
    if (typeof context !== 'object' || Array.isArray(context))
      throw bad('context must be an object.', 'Send { "inputs": [...], "collectionId": "..." }.');
    const { ctx, controller, storage } = await open(c.req.raw);
    const collectionId = optionalString(context.collectionId, 'context.collectionId');
    const opts: AskOptions = {
      question: last.content,
      history: messages.slice(0, -1),
      inputs: stringList(context.inputs, 'context.inputs'),
      ...(collectionId ? { collectionId } : {}),
      storage,
      model: readModel(body.model),
      maxTokens: optionalNumber(body.maxTokens, 'maxTokens', 64, 16_384),
      temperature: optionalNumber(body.temperature, 'temperature', 0, 2),
    };
    return stream(c, opts, ctx, controller);
  });

  return app;
}
