/**
 * One model per index. Vectors from different embedding models live in
 * different spaces (often with different sizes), so comparing them gives
 * meaningless scores. An index records the rung id it was built with
 * (VectorRecord.model) and every later embed for that index, documents and
 * queries alike, must use exactly that rung's model. These helpers never fall
 * back to another model. The only stand-ins they allow are pooled keys of the
 * same service and model ('embed/mistral/mistral-embed' and
 * 'embed/mistral#2/mistral-embed'), which return identical vectors.
 */
import {
  type ChainOptions,
  type Ctx,
  type EmbedRung,
  type Env,
  isInputError,
  isRungEnabled,
  keylessAllowed,
  type Registry,
  rankRungs,
  Vid2ContextError,
} from '@vid2context/core';
import { type EmbedMode, isRetrievalRung } from './rung.ts';

/** Longest wait for a rate-limited rung before giving up, in seconds. OVH keyless resets within a minute. */
const MAX_WAIT_SEC = 75;
/** Waits per batch on a rate-limited rung. */
const MAX_WAITS = 3;

/** The id an index records: the rung id without a pooled-key suffix ('embed/groq#2/x' becomes 'embed/groq/x'). */
export function canonicalRungId(id: string): string {
  return id.replace(/^([^/]+\/[^/#]+)#\d+(?=\/|$)/, '$1');
}

function enabledIds(rungs: EmbedRung[], env: Env): string[] {
  return [...new Set(rankRungs(rungs, {}, env).map((r) => canonicalRungId(r.id)))];
}

function otherRungsText(rungs: EmbedRung[], env: Env, except?: string): string {
  const ids = enabledIds(rungs, env).filter((id) => id !== except);
  return ids.length > 0 ? `Enabled embedding rungs: ${ids.join(', ')}.` : 'No other embedding rung is enabled.';
}

/**
 * The rung id a new index should use: VID2CONTEXT_EMBED_MODEL when set,
 * otherwise the first enabled rung in policy order (free first by default).
 * Store the result with the index and pass it to embedWithModel and
 * embedQuery from then on.
 */
export function pickEmbedModel(registry: Registry, env: Env, opts: ChainOptions = {}): string {
  const rungs = registry.embedRungs(env);
  const pinned = env.VID2CONTEXT_EMBED_MODEL?.trim();
  if (pinned) {
    const id = canonicalRungId(pinned);
    if (!rungs.some((r) => canonicalRungId(r.id) === id)) {
      throw new Vid2ContextError('not-found', `VID2CONTEXT_EMBED_MODEL names an unknown embedding rung: ${pinned}.`, {
        hint: `Set it to a rung id such as embed/ovh/bge-m3. ${otherRungsText(rungs, env)}`,
      });
    }
    return id;
  }
  const first = rankRungs(rungs, opts, env)[0];
  if (!first) {
    throw new Vid2ContextError('no-provider', 'No embedding rung is enabled.', {
      hint: 'Unset VID2CONTEXT_KEYLESS to use OVH bge-m3 without a key, or configure a local or free embedding rung (docs/guides/embeddings.md).',
    });
  }
  return canonicalRungId(first.id);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The rungs that may serve `rungId`: that rung first, then pooled keys of the same service and model, enabled only. */
export function pinnedRungs(registry: Registry, rungId: string, env: Env): EmbedRung[] {
  const all = registry.embedRungs(env);
  const id = canonicalRungId(rungId);
  const group = all.filter((r) => canonicalRungId(r.id) === id);
  if (group.length === 0) {
    throw new Vid2ContextError('not-found', `Unknown embedding model: ${rungId}.`, {
      hint: `This index was built with a rung this build does not have. Install or configure it, or re-index with another model (which re-embeds every chunk). ${otherRungsText(all, env)}`,
    });
  }
  const usable = group
    .filter((r) => isRungEnabled(r, env) && (r.tier !== 'keyless' || keylessAllowed(env)))
    .sort((a, b) => Number(b.id === rungId) - Number(a.id === rungId));
  if (usable.length === 0) {
    const needs = [...new Set(group.flatMap((r) => r.requires))];
    const keyless = group.some((r) => r.tier === 'keyless');
    throw new Vid2ContextError('no-provider', `Embedding model ${id} is not enabled.`, {
      hint: `${keyless ? 'Unset VID2CONTEXT_KEYLESS to allow it.' : `Set ${needs.join(' and ') || 'its configuration'} to enable it.`} Using another model instead means re-indexing. ${otherRungsText(all, env, id)}`,
    });
  }
  return usable;
}

async function embedPinned(registry: Registry, rungId: string, texts: string[], mode: EmbedMode, ctx: Ctx): Promise<number[][]> {
  if (texts.length === 0) return [];
  const rungs = pinnedRungs(registry, rungId, ctx.env);
  const first = rungs[0] as EmbedRung;
  const size = isRetrievalRung(first) ? first.maxBatch : texts.length;
  const out: number[][] = [];
  for (let start = 0; start < texts.length; start += size) {
    const chunk = texts.slice(start, start + size);
    out.push(...(await embedChunk(rungs, chunk, mode, ctx, rungId, registry)));
  }
  return out;
}

async function embedChunk(
  rungs: EmbedRung[],
  chunk: string[],
  mode: EmbedMode,
  ctx: Ctx,
  rungId: string,
  registry: Registry,
): Promise<number[][]> {
  let lastErr: unknown;
  for (let wait = 0; wait <= MAX_WAITS; wait++) {
    let shortestRetry = Number.POSITIVE_INFINITY;
    for (const rung of rungs) {
      try {
        return mode === 'query' && isRetrievalRung(rung) ? await rung.embedQueries(chunk, ctx) : await rung.embed(chunk, ctx);
      } catch (err) {
        if (isInputError(err)) throw err;
        if (ctx.signal?.aborted) throw err;
        lastErr = err;
        if (err instanceof Vid2ContextError && err.code === 'rate-limited') {
          shortestRetry = Math.min(shortestRetry, err.retryAfterSec ?? 30);
        } else {
          shortestRetry = Number.NaN;
        }
        ctx.log.warn('embedding rung failed', { rung: rung.id, reason: err instanceof Vid2ContextError ? err.code : 'error' });
      }
    }
    // Wait only when every candidate was rate-limited with a short reset.
    if (!Number.isFinite(shortestRetry) || shortestRetry > MAX_WAIT_SEC || wait === MAX_WAITS) break;
    ctx.log.info('embedding model is rate-limited, waiting for its quota to reset', { rung: rungId, seconds: shortestRetry });
    await sleep(Math.max(1, shortestRetry) * 1000, ctx.signal);
  }
  const id = canonicalRungId(rungId);
  const code = lastErr instanceof Vid2ContextError ? lastErr.code : 'upstream';
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Vid2ContextError(
    code === 'all-rungs-failed' ? 'upstream' : code,
    `Embedding with ${id} failed: ${detail}`.slice(0, 600),
    {
      cause: lastErr,
      status: lastErr instanceof Vid2ContextError ? lastErr.status : undefined,
      retryAfterSec: lastErr instanceof Vid2ContextError ? lastErr.retryAfterSec : undefined,
      hint: `This index is pinned to ${id}, so no other model was tried: vectors from different models cannot be compared. Retry later, add more keys for the same service (<PROVIDER>_FALLBACK_KEYS), or re-index everything with another model. ${otherRungsText(registry.embedRungs(ctx.env), ctx.env, id)}`,
    },
  );
}

/**
 * Embed passages with exactly the rung `rungId` (or pooled keys of the same
 * service and model). Never falls back to another model. Waits out short
 * rate limits, then throws with a hint that switching models means re-indexing.
 */
export function embedWithModel(registry: Registry, rungId: string, texts: string[], ctx: Ctx): Promise<number[][]> {
  return embedPinned(registry, rungId, texts, 'passage', ctx);
}

/**
 * Embed a search query with the model an index was built with, using that
 * model's query convention (e5 'query: ', nomic 'search_query: ', the Qwen3
 * instruction, Jina's retrieval.query adapter).
 */
export async function embedQuery(registry: Registry, index: { model: string }, query: string, ctx: Ctx): Promise<number[]> {
  const [v] = await embedPinned(registry, index.model, [query], 'query', ctx);
  return v as number[];
}
