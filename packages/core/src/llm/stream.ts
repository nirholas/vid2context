/**
 * Chain-aware streaming chat. Same free-first ranking as `chat()`, but the
 * answer arrives as events while it is generated.
 *
 * Fallback rule: a rung that fails before its first answer delta is skipped
 * and the next rung is tried; once a delta has been emitted the stream is
 * committed to that rung and a later failure ends the stream with an error
 * carrying every attempt.
 *
 * Opening a stream and reading its first event runs through `runChain`, so a
 * rung that answers 429 or 401 cools down exactly as it does for `chat()`
 * (the cooldown table in chain.ts is private, and this shares it instead of
 * copying it). A failure after the first event (for example mid-reasoning)
 * records an attempt but sets no cooldown.
 */
import { attemptsOf, rankRungs, resolveChainOptions, runChain } from '../chain.ts';
import { isInputError, Vid2ContextError } from '../errors.ts';
import { type ChatStreamEvent, streamFromRung } from '../llm-stream.ts';
import type { ChainOptions, ChatRequest, ChatResult, LlmRung } from '../provider.ts';
import type { Registry } from '../registry.ts';
import type { Attempt, Ctx } from '../types.ts';

/** Chain options plus rung ids to try first (a non-strict model choice), then the normal order. */
export interface StreamChainOptions extends ChainOptions {
  prefer?: string[];
}

/**
 * Events from `chatStream`: the shared ChatStreamEvent kinds, plus `meta`
 * naming the rung that is answering, and a `done` that also carries the rung
 * and the attempts.
 *
 * `meta` comes first. It is sent again, with `restart: true`, only when a
 * rung fails after streaming reasoning but before any answer text; clients
 * then discard the reasoning they showed.
 */
export type ChainStreamEvent =
  | { type: 'meta'; rung: string; model: string; contextTokens?: number; restart?: boolean }
  | Exclude<ChatStreamEvent, { type: 'done' }>
  | { type: 'done'; result: ChatResult; rung: string; attempts: Attempt[] };

interface Opened {
  it: AsyncIterator<ChatStreamEvent>;
  first: ChatStreamEvent;
}

async function openStream(rung: LlmRung, req: ChatRequest, ctx: Ctx): Promise<Opened> {
  const it = streamFromRung(rung, req, ctx)[Symbol.asyncIterator]();
  try {
    const step = await it.next();
    if (step.done) throw new Vid2ContextError('upstream', `${rung.id}: stream ended without output.`);
    return { it, first: step.value };
  } catch (err) {
    await it.return?.().catch(() => {});
    throw err;
  }
}

function reasonFor(err: unknown): string {
  if (err instanceof Vid2ContextError) return err.status ? `${err.code}-${err.status}` : err.code;
  if (err instanceof Error && err.name === 'AbortError') return 'aborted';
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  return 'error';
}

function withAttempts(err: unknown, attempts: Attempt[]): Error {
  const e =
    err instanceof Error
      ? err
      : new Vid2ContextError('upstream', String(err), { hint: 'The model stopped mid-answer; try again or pick another model.' });
  return Object.assign(e, { attempts: [...attempts] });
}

/** Add attempts from one runChain pass, without repeating cooldown skips already listed. Failed rungs join `excluded`. */
function merge(into: Attempt[], more: Attempt[], excluded: Set<string>): void {
  for (const a of more) {
    if (a.outcome === 'error') excluded.add(a.id);
    if (a.outcome === 'skipped' && into.some((b) => b.id === a.id && b.outcome === 'skipped' && b.reason === a.reason)) continue;
    into.push(a);
  }
}

/**
 * Stream a chat answer along the rung chain. Yields `meta`, then `reasoning`
 * and `delta` events, then one `done`. Throws `no-provider` when nothing is
 * enabled, `all-rungs-failed` when every rung failed before answering, or
 * the rung's own error once answer text has been emitted; each error carries
 * `attempts` (read them with `attemptsOf`).
 */
export async function* chatStream(
  registry: Registry,
  req: ChatRequest,
  chain: StreamChainOptions,
  ctx: Ctx,
): AsyncGenerator<ChainStreamEvent> {
  const needs = [...(chain.needs ?? [])];
  if (req.json && typeof req.json === 'object' && !needs.includes('json')) needs.push('json');
  const { prefer = [], ...base } = chain;
  const opts: ChainOptions = { ...base, needs };
  const all = registry.llmRungs(ctx.env);
  const attempts: Attempt[] = [];

  const ranked = rankRungs(all, opts, ctx.env);
  if (ranked.length === 0) {
    throw Object.assign(
      new Vid2ContextError('no-provider', 'No llm rung is enabled.', {
        hint: 'Configure an llm provider (see docs/providers.md). Keyless lanes need VID2CONTEXT_KEYLESS unset; local-only policy needs a local rung.',
      }),
      { attempts },
    );
  }
  const { maxAttempts } = resolveChainOptions(opts, ctx.env);

  // Preferred rungs run first (only those the chain would allow anyway), then everything else.
  const preferred = ranked.filter((r) => prefer.includes(r.id)).map((r) => r.id);
  for (const id of prefer) {
    if (!preferred.includes(id)) attempts.push({ id, stage: 'llm', outcome: 'skipped', reason: 'not-eligible' });
  }
  const passes: ChainOptions[] = preferred.length > 0 ? [{ ...opts, only: preferred }, { ...opts }] : [{ ...opts }];
  // Rungs already tried in this request; they are not tried twice.
  const excluded = new Set<string>();
  let metaRung: string | undefined;
  let tried = 0;

  for (let p = 0; p < passes.length; p++) {
    const pass = passes[p] as ChainOptions;
    // The second pass skips the preferred rungs, which the first pass already tried.
    if (p > 0) for (const id of preferred) excluded.add(id);
    while (tried < maxAttempts) {
      if (ctx.signal?.aborted) break;
      const skip = [...(pass.skip ?? []), ...excluded];
      // Stop when nothing is left in this pass, so runChain's no-provider error does not mask earlier attempts.
      if (rankRungs(all, { ...pass, skip }, ctx.env).length === 0) break;
      let opened: { value: Opened; rung: LlmRung; attempts: Attempt[] };
      try {
        opened = await runChain<LlmRung, Opened>(
          'llm',
          all,
          (r) => openStream(r, req, ctx),
          { ...pass, skip, maxAttempts: maxAttempts - tried },
          ctx,
        );
      } catch (err) {
        if (isInputError(err)) throw withAttempts(err, [...attempts, ...attemptsOf(err)]);
        const more = attemptsOf(err);
        tried += more.filter((a) => a.outcome !== 'skipped').length;
        merge(attempts, more, excluded);
        break;
      }
      const { rung } = opened;
      const { it, first } = opened.value;
      // runChain's 'ok' means the stream opened; the final outcome is recorded below.
      const connected = opened.attempts.pop();
      tried += opened.attempts.filter((a) => a.outcome !== 'skipped').length + 1;
      merge(attempts, opened.attempts, excluded);
      const started = Date.now() - (connected?.ms ?? 0);

      const restart = metaRung !== undefined;
      metaRung = rung.id;
      yield {
        type: 'meta',
        rung: rung.id,
        model: rung.model,
        ...(rung.contextTokens !== undefined ? { contextTokens: rung.contextTokens } : {}),
        ...(restart ? { restart: true } : {}),
      };

      let committed = false;
      let finished = false;
      try {
        let ev: ChatStreamEvent | undefined = first;
        while (ev) {
          if (ev.type === 'done') {
            attempts.push({ id: rung.id, stage: 'llm', outcome: 'ok', ms: Date.now() - started });
            finished = true;
            yield { type: 'done', result: ev.result, rung: rung.id, attempts: [...attempts] };
            return;
          }
          if (ev.type === 'delta') committed = true;
          yield ev;
          const step: IteratorResult<ChatStreamEvent> = await it.next();
          ev = step.done ? undefined : step.value;
        }
        throw new Vid2ContextError('upstream', `${rung.id}: stream ended without a final result.`);
      } catch (err) {
        if (finished) throw err;
        attempts.push({
          id: rung.id,
          stage: 'llm',
          outcome: 'error',
          reason: reasonFor(err),
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          ms: Date.now() - started,
        });
        if (committed || isInputError(err) || ctx.signal?.aborted) throw withAttempts(err, attempts);
        ctx.log.warn('llm rung failed before answering, trying the next one', { rung: rung.id, reason: reasonFor(err) });
        excluded.add(rung.id);
      } finally {
        await it.return?.().catch(() => {});
      }
    }
  }

  if (ctx.signal?.aborted) {
    throw withAttempts(ctx.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'), attempts);
  }
  throw Object.assign(
    new Vid2ContextError('all-rungs-failed', `Every llm rung failed (${attempts.length} tried).`, {
      hint: 'See `attempts` for each failure. Adding a free key (docs/providers.md) adds more rungs.',
    }),
    { attempts },
  );
}
