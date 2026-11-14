/**
 * The answer engine.
 *
 *   prepareAsk    resolve what to ground in, pick the model plan, size the
 *                 source budget to the model window, condense a follow-up into
 *                 a standalone query, retrieve numbered sources, build the prompt.
 *                 Throws Vid2ContextError on bad input (before any streaming).
 *   streamAnswer  generate through core's chatStream (falls back to the next
 *                 rung only before the first answer delta), filter citations
 *                 as they stream, then report verified citations. Never
 *                 throws: a failure is an `error` event.
 *   askStream     both, as one event stream.
 *   ask           the same, collected into one result.
 */
import {
  type Attempt,
  attemptsOf,
  type ChainOptions,
  type ChatRequest,
  type Ctx,
  chat,
  chatStream,
  type Env,
  type ErrorCode,
  getVideoContext,
  type LlmRung,
  type Registry,
  rankRungs,
  resolveModelChoice,
  type StreamChainOptions,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { buildCitations, CitationFilter } from './cite.ts';
import { answerMessages, condenseMessages, messagesTokens, overheadTokens, PER_SOURCE_TOKENS } from './prompt.ts';
import { defaultRetriever } from './retrieve.ts';
import type { AskEvent, AskOptions, AskResult, HistoryMessage, RetrievalScope, Source, Usage } from './types.ts';

export const LIMITS = {
  questionChars: 4000,
  historyMessages: 40,
  historyChars: 40_000,
  inputs: 50,
};

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_SOURCE_TOKENS = 32_000;
/** Assumed window for rungs that do not declare one. */
const DEFAULT_WINDOW = 8192;
/** Never send fewer source tokens than this, even to a tiny window. */
const MIN_SOURCE_TOKENS = 1000;

export interface PreparedAsk {
  question: string;
  /** The query used for retrieval: the question, or a standalone rewrite of a follow-up. */
  query: string;
  sources: Source[];
  contexts: VideoContext[];
  request: ChatRequest;
  /** Chain options from the model choice, with rungs whose window is too small skipped. */
  chain: StreamChainOptions;
  promptTokens: number;
  /** Attempts made while preparing (the condense call, rungs skipped for a small window). */
  attempts: Attempt[];
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function validate(opts: AskOptions): HistoryMessage[] {
  const q = typeof opts.question === 'string' ? opts.question.trim() : '';
  if (!q) throw bad('The question is empty.', 'Send the question as a non-empty string.');
  if (q.length > LIMITS.questionChars) {
    throw bad(`The question is ${q.length} characters long.`, `Keep the question under ${LIMITS.questionChars} characters.`);
  }
  const history = opts.history ?? [];
  if (
    !Array.isArray(history) ||
    history.some((m) => !m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string')
  ) {
    throw bad('history must be a list of { role: "user" | "assistant", content } messages.', 'Send earlier turns oldest first.');
  }
  if (history.length > LIMITS.historyMessages) {
    throw bad(`history has ${history.length} messages.`, `Send at most the last ${LIMITS.historyMessages} turns.`);
  }
  if (history.reduce((n, m) => n + m.content.length, 0) > LIMITS.historyChars) {
    throw bad(
      'history is too long.',
      `Keep earlier turns under ${LIMITS.historyChars} characters in total, or start a new chat.`,
    );
  }
  if ((opts.inputs?.length ?? 0) > LIMITS.inputs) {
    throw bad(
      `${opts.inputs?.length} inputs were given.`,
      `Ask about at most ${LIMITS.inputs} videos at once, or put them in a collection.`,
    );
  }
  return history;
}

async function resolveContexts(registry: Registry, opts: AskOptions, ctx: Ctx): Promise<VideoContext[]> {
  const out: VideoContext[] = [...(opts.contexts ?? [])];
  const inputs = (opts.inputs ?? []).map((s) => s.trim()).filter(Boolean);
  // A few at a time: each may hit the network.
  for (let i = 0; i < inputs.length; i += 4) {
    const batch = inputs.slice(i, i + 4);
    out.push(...(await Promise.all(batch.map((input) => getVideoContext(registry, input, { storage: opts.storage }, ctx)))));
  }
  if (opts.collectionId) {
    const collection = await opts.storage.getCollection(opts.collectionId);
    if (!collection) {
      throw new Vid2ContextError('not-found', `Collection not found: ${opts.collectionId}`, {
        hint: 'List collections to see valid ids.',
      });
    }
    for (const id of collection.videoIds) {
      const c = await opts.storage.getContext(id);
      if (c) out.push(c);
      else ctx.log.warn('ask: a collection video has no saved context, skipping it', { id });
    }
  }
  const seen = new Set<string>();
  const unique = out.filter((c) => {
    const id = c.metadata.ref.id;
    if (seen.has(id) || c.transcript.segments.length === 0) return false;
    seen.add(id);
    return true;
  });
  if (unique.length === 0) {
    throw bad(
      opts.collectionId ? 'The collection has no saved transcripts yet.' : 'Nothing to ground the answer in.',
      opts.collectionId
        ? 'Add videos to the collection and wait for the ingest to finish.'
        : 'Pass inputs (video URLs, ids like youtube:abc, or upload:<sha256>) or a collectionId.',
    );
  }
  return unique;
}

/** Chain options for the condense call: never wider than what the user allowed for the answer. */
function condenseOptions(chain: StreamChainOptions): ChainOptions {
  if (chain.only) return { only: chain.only, maxAttempts: 1 };
  if (chain.policy === 'local-only') return { policy: 'local-only', maxAttempts: 3 };
  return { policy: 'free', maxAttempts: 3 };
}

/** The rung that will be tried first for these chain options: a preferred rung when eligible, else the head of the ranking. Pure. */
export function firstRung(registry: Registry, chain: StreamChainOptions, env: Env): LlmRung | undefined {
  const { prefer = [], ...opts } = chain;
  const ranked = rankRungs(registry.llmRungs(env), opts, env);
  return ranked.find((r) => prefer.includes(r.id)) ?? ranked[0];
}

async function condense(
  registry: Registry,
  question: string,
  history: HistoryMessage[],
  chain: StreamChainOptions,
  ctx: Ctx,
  attempts: Attempt[],
): Promise<string> {
  try {
    const res = await chat(
      registry,
      { messages: condenseMessages(question, history), maxTokens: 512, temperature: 0 },
      condenseOptions(chain),
      ctx,
    );
    attempts.push(...res.attempts);
    const q =
      res.text
        .split('\n')[0]
        ?.replace(/^["'\s]+|["'\s]+$/g, '')
        .trim() ?? '';
    if (q.length > 0 && q.length <= 500) return q;
  } catch (err) {
    attempts.push(...attemptsOf(err));
    ctx.log.warn('ask: could not condense the follow-up, searching with the recent user turns instead');
  }
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
  return `${lastUser.slice(0, 500)} ${question}`.trim();
}

export async function prepareAsk(registry: Registry, opts: AskOptions, ctx: Ctx): Promise<PreparedAsk> {
  const history = validate(opts);
  const question = opts.question.trim();
  const contexts = await resolveContexts(registry, opts, ctx);
  const chain = resolveModelChoice(opts.model, registry, ctx.env);
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const attempts: Attempt[] = [];

  // Size the source budget to the first rung's window, with room for the history, the answer and estimate error.
  const first = firstRung(registry, chain, ctx.env);
  const window = first?.contextTokens ?? DEFAULT_WINDOW;
  const room = Math.floor(window * 0.9) - overheadTokens(question, history) - maxTokens;
  const cap = opts.maxSourceTokens ?? DEFAULT_MAX_SOURCE_TOKENS;
  // Leave room for one header line per ~180-token chunk.
  const budgetTokens = Math.max(MIN_SOURCE_TOKENS, Math.floor(Math.min(room, cap) * (1 - PER_SOURCE_TOKENS / 200)));

  const retriever = opts.retriever ?? defaultRetriever;
  const scope: RetrievalScope = {
    contexts,
    storage: opts.storage,
    budgetTokens,
    registry,
    ...(opts.collectionId ? { collectionId: opts.collectionId } : {}),
  };
  const needsQuery = retriever.needsQuery ? retriever.needsQuery(scope) : true;
  const query = history.length > 0 && needsQuery ? await condense(registry, question, history, chain, ctx, attempts) : question;
  const sources = await retriever.retrieve(query, scope, ctx);

  const messages = answerMessages(question, sources, history);
  const promptTokens = messagesTokens(messages);
  const need = promptTokens + maxTokens;
  // Skip rungs whose window cannot hold this prompt, like the pipeline skips speech rungs for audio that is too large.
  const { prefer: _prefer, ...rankOpts } = chain;
  const small = rankRungs(registry.llmRungs(ctx.env), rankOpts, ctx.env).filter(
    (r) => r.contextTokens !== undefined && r.contextTokens < need,
  );
  for (const r of small) {
    attempts.push({
      id: r.id,
      stage: 'llm',
      outcome: 'skipped',
      reason: 'too-large',
      detail: `${need} > ${r.contextTokens} tokens`,
    });
  }
  const fitted: StreamChainOptions =
    small.length > 0 ? { ...chain, skip: [...(chain.skip ?? []), ...small.map((r) => r.id)] } : chain;

  return {
    question,
    query,
    sources,
    contexts,
    request: { messages, maxTokens, temperature: opts.temperature ?? DEFAULT_TEMPERATURE },
    chain: fitted,
    promptTokens,
    attempts,
  };
}

function errorEvent(err: unknown, attempts: Attempt[]): AskEvent {
  const e = err instanceof Vid2ContextError ? err : undefined;
  const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  return {
    type: 'error',
    code: e?.code ?? (aborted ? 'timeout' : 'upstream'),
    message: e?.message ?? (err instanceof Error ? err.message : String(err)),
    ...(e?.hint ? { hint: e.hint } : {}),
    attempts,
  };
}

/**
 * Generate the answer for a prepared request through core's chatStream (the
 * free-first chain; a rung that fails before its first answer delta is
 * skipped). Yields meta, reasoning*, delta+, then done; or error. Never throws.
 */
export async function* streamAnswer(prepared: PreparedAsk, registry: Registry, ctx: Ctx): AsyncGenerator<AskEvent> {
  const sources = prepared.sources.map(({ text: _text, ...ref }) => ref);
  const filter = new CitationFilter(new Set(prepared.sources.map((s) => s.n)));
  try {
    for await (const ev of chatStream(registry, prepared.request, prepared.chain, ctx)) {
      if (ev.type === 'meta') {
        yield {
          type: 'meta',
          rung: ev.rung,
          model: ev.model,
          ...(ev.contextTokens !== undefined ? { contextTokens: ev.contextTokens } : {}),
          promptTokens: prepared.promptTokens,
          sources,
          ...(ev.restart ? { restart: true } : {}),
        };
      } else if (ev.type === 'reasoning') {
        if (ev.text) yield { type: 'reasoning', text: ev.text };
      } else if (ev.type === 'delta') {
        const out = filter.push(ev.text);
        if (out) yield { type: 'delta', text: out };
      } else {
        const tail = filter.end();
        if (tail) yield { type: 'delta', text: tail };
        const text = filter.state.text.trim();
        const usage: Usage | undefined = ev.result.usage;
        yield {
          type: 'done',
          text,
          rung: ev.rung,
          model: ev.result.model,
          ...(usage ? { usage } : {}),
          citations: buildCitations(text, filter.state.used, prepared.sources, prepared.contexts),
          unverified: filter.state.unverified,
          attempts: [...prepared.attempts, ...ev.attempts],
        };
      }
    }
  } catch (err) {
    yield errorEvent(err, [...prepared.attempts, ...attemptsOf(err)]);
  }
}

/** Prepare and answer as one stream. Preparation failures become an `error` event too. */
export async function* askStream(registry: Registry, opts: AskOptions, ctx: Ctx): AsyncGenerator<AskEvent> {
  let prepared: PreparedAsk;
  try {
    prepared = await prepareAsk(registry, opts, ctx);
  } catch (err) {
    yield errorEvent(err, attemptsOf(err));
    return;
  }
  yield* streamAnswer(prepared, registry, ctx);
}

/** Answer a question with verified citations. Throws Vid2ContextError (with `attempts`) on failure. */
export async function ask(registry: Registry, opts: AskOptions, ctx: Ctx): Promise<AskResult> {
  const prepared = await prepareAsk(registry, opts, ctx);
  for await (const ev of streamAnswer(prepared, registry, ctx)) {
    if (ev.type === 'error') {
      throw Object.assign(new Vid2ContextError(ev.code as ErrorCode, ev.message, ev.hint ? { hint: ev.hint } : {}), {
        attempts: ev.attempts ?? [],
      });
    }
    if (ev.type === 'done') {
      return {
        answer: ev.text,
        citations: ev.citations,
        unverified: ev.unverified,
        sources: prepared.sources,
        rung: ev.rung,
        model: ev.model,
        ...(ev.usage ? { usage: ev.usage } : {}),
        attempts: ev.attempts,
      };
    }
  }
  throw new Vid2ContextError('upstream', 'The answer stream ended without a result.', { hint: 'Retry the question.' });
}
