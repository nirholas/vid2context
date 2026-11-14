/**
 * extract(): schema-validated, cited structured extraction (templates such
 * as buyer-guide, or any JSON Schema in the supported subset).
 *
 *   fits one call?  yes -> one extraction call over every source
 *                   no  -> one call per chunk (each video cut by budget at
 *                          line boundaries), then a merge call over the
 *                          partial JSON results
 *   validate        the answer is checked against the schema; on failure
 *                   exactly one repair call sends the errors back
 *   verify          every citation object ({videoId, startSec, quote})
 *                   anywhere in the result is checked against the transcript
 *                   and replaced with a full Citation (title, snapped
 *                   startSec, endSec, timestamp url, quote), or removed and
 *                   listed in `unverified`. A template item whose citations
 *                   all fail is removed too: nothing uncited is presented as
 *                   cited.
 */
import { attemptsOf, type ChatMessage, estimateTokens, timestampUrl, Vid2ContextError, type VideoContext } from '@vid2context/core';
import type { InsightsDeps } from './brief.ts';
import { chatJson, type JsonAnswer, Ledger, sourceBudget, withJson } from './llm.ts';
import { extractionSchema, extractMessages, mergeMessages, repairMessages } from './prompts.ts';
import { type JsonSchema, validate } from './schema.ts';
import { renderSource, type Source, type SourceSet, sourceSet } from './sources.ts';
import type { Template } from './templates/index.ts';
import { chunkLines } from './text.ts';
import type { Citation, ExtractionResult, LlmOptions, UnverifiedClaim } from './types.ts';
import { verifyQuote } from './verify.ts';

export interface ExtractOptions extends LlmOptions {
  /** Template id (default `summary` when no schema is given). */
  template?: string;
  /** A custom JSON Schema. The result is `{ data, citations }` with `data` matching it. */
  schema?: JsonSchema;
  question?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const pointer = (k: string | number) => `/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function isCite(v: unknown): v is { videoId: unknown; startSec: unknown; quote: unknown; path?: unknown } {
  return isObject(v) && 'videoId' in v && 'quote' in v && 'startSec' in v;
}

/** A short label for the item that holds a citation: its first string field. */
function describe(item: unknown): string {
  if (!isObject(item)) return '';
  for (const [k, v] of Object.entries(item)) if (k !== 'sources' && typeof v === 'string' && v.trim()) return v.trim();
  return '';
}

interface CiteSlot {
  holder: unknown[] | Record<string, unknown>;
  key: number | string;
  path: string;
  /** The array item that owns this citation's `sources` list, when there is one. */
  owner?: { list: unknown[]; index: number; path: string };
}

function collect(v: unknown, path: string, slots: CiteSlot[], owner?: CiteSlot['owner']): void {
  if (Array.isArray(v)) {
    v.forEach((item, i) => {
      if (isCite(item)) slots.push({ holder: v, key: i, path: `${path}${pointer(i)}`, owner });
      else collect(item, `${path}${pointer(i)}`, slots, isObject(item) ? { list: v, index: i, path: `${path}${pointer(i)}` } : owner);
    });
  } else if (isObject(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (isCite(val)) slots.push({ holder: v, key: k, path: `${path}${pointer(k)}`, owner });
      else collect(val, `${path}${pointer(k)}`, slots, owner);
    }
  }
}

/**
 * Verify every citation object inside `data`, in place. Returns the verified
 * citations (with their final JSON pointers) and the failures.
 */
export function verifyExtraction(
  data: unknown,
  set: SourceSet,
): { data: unknown; citations: (Citation & { path: string })[]; unverified: UnverifiedClaim[] } {
  const slots: CiteSlot[] = [];
  collect(data, '', slots);
  const unverified: UnverifiedClaim[] = [];
  const good = new WeakSet<object>();
  const removals = new Map<unknown[], Set<number>>();
  const failedOwners = new Map<string, { owner: NonNullable<CiteSlot['owner']>; reason: UnverifiedClaim }>();
  const ownerHits = new Map<string, number>();

  for (const slot of slots) {
    const raw = (slot.holder as Record<string | number, unknown>)[slot.key] as {
      videoId: unknown;
      startSec: unknown;
      quote: unknown;
      path?: unknown;
    };
    const source: Source | undefined = set.find(raw.videoId);
    const claim = describe(slot.owner ? slot.owner.list[slot.owner.index] : undefined) || (typeof raw.path === 'string' ? raw.path : '');
    const r = source
      ? verifyQuote(source.context, raw.quote, raw.startSec)
      : { ok: false as const, reason: 'unknown-video' as const, detail: `"${String(raw.videoId)}" is not one of the sources.`, score: 0 };
    if (r.ok && source && r.startSec !== undefined) {
      const url = timestampUrl(source.context.metadata.ref, r.startSec);
      const cite: Citation & { path?: string } = {
        videoId: source.summary.videoId,
        title: source.summary.title,
        startSec: r.startSec,
        ...(r.endSec !== undefined ? { endSec: r.endSec } : {}),
        ...(url ? { url } : {}),
        quote: String(raw.quote),
        ...(typeof raw.path === 'string' ? { path: raw.path } : {}),
      };
      (slot.holder as Record<string | number, unknown>)[slot.key] = cite;
      good.add(cite);
      if (slot.owner) ownerHits.set(slot.owner.path, (ownerHits.get(slot.owner.path) ?? 0) + 1);
      continue;
    }
    const entry: UnverifiedClaim = {
      claim,
      quote: typeof raw.quote === 'string' ? raw.quote : undefined,
      videoId: source?.summary.videoId ?? (typeof raw.videoId === 'string' ? raw.videoId : undefined),
      ...(typeof raw.startSec === 'number' ? { startSec: raw.startSec } : {}),
      reason: r.reason ?? 'quote-not-found',
      detail: r.detail,
      ...('foundAtSec' in r && r.foundAtSec !== undefined ? { foundAtSec: r.foundAtSec } : {}),
      path: typeof raw.path === 'string' ? raw.path : slot.path,
    };
    unverified.push(entry);
    if (Array.isArray(slot.holder)) {
      const set = removals.get(slot.holder) ?? new Set<number>();
      set.add(slot.key as number);
      removals.set(slot.holder, set);
    } else {
      delete slot.holder[slot.key as string];
    }
    if (slot.owner && !failedOwners.has(slot.owner.path)) failedOwners.set(slot.owner.path, { owner: slot.owner, reason: entry });
  }

  // Items whose citations all failed lose their only evidence: remove them.
  for (const [path, { owner }] of failedOwners) {
    if ((ownerHits.get(path) ?? 0) > 0) continue;
    const set = removals.get(owner.list) ?? new Set<number>();
    set.add(owner.index);
    removals.set(owner.list, set);
  }
  for (const [list, indexes] of removals) {
    for (const i of [...indexes].sort((a, b) => b - a)) list.splice(i, 1);
  }

  const citations: (Citation & { path: string })[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}${pointer(i)}`));
    else if (isObject(v)) {
      if (good.has(v)) {
        const c = v as unknown as Citation & { path?: string };
        citations.push({ ...c, path: c.path ?? path });
        return;
      }
      for (const [k, x] of Object.entries(v)) walk(x, `${path}${pointer(k)}`);
    }
  };
  walk(data, '');
  return { data, citations, unverified };
}

/** Validate the answer; on failure send exactly one repair call with the errors. */
async function validated(
  answer: JsonAnswer,
  messages: ChatMessage[],
  schema: JsonSchema,
  c: { deps: InsightsDeps; ledger: Ledger; opts: ExtractOptions },
): Promise<{ value: Record<string, unknown>; repaired: boolean }> {
  const errors = answer.value ? validate(schema, answer.value) : ['/: the answer is not a JSON object'];
  if (errors.length === 0 && answer.value) return { value: answer.value, repaired: false };
  c.deps.ctx.log.info('extraction failed schema validation, sending one repair call', { errors: errors.length });
  const repair = await chatJson(
    c.deps.registry,
    { step: 'repair', messages: repairMessages(messages, answer.text, errors), chain: c.opts.chain, maxTokens: c.opts.maxOutputTokens },
    c.ledger,
    c.deps.ctx,
  );
  const after = repair.value ? validate(schema, repair.value) : ['/: the answer is not a JSON object'];
  if (after.length > 0 || !repair.value) {
    throw Object.assign(
      new Vid2ContextError('upstream', `The model's answer did not match the schema after one repair: ${after.slice(0, 5).join('; ')}`, {
        hint: 'Retry, pick a stronger rung (chain.only or policy "quality"), or simplify the schema (fewer required fields, looser limits).',
      }),
      { attempts: c.ledger.attempts },
    );
  }
  return { value: repair.value, repaired: true };
}

/** Structured, cited extraction on the server with the LLM chain. */
export async function extract(contexts: VideoContext[], opts: ExtractOptions, deps: InsightsDeps): Promise<ExtractionResult> {
  if (opts.template && opts.schema) {
    throw new Vid2ContextError('bad-request', 'Pass either template or schema, not both.', {
      hint: 'Use a template id (buyer-guide, tutorial-steps, comparison, summary, brief) or a custom JSON Schema.',
    });
  }
  const { schema, template } = extractionSchema(opts);
  const custom = opts.schema !== undefined;
  const set = sourceSet(contexts);
  const ledger = new Ledger();
  const chain = withJson(opts.chain);
  const budget = sourceBudget(deps.registry, deps.ctx, chain, opts);
  const c = { deps, ledger, opts: { ...opts, chain } };

  const total = set.sources.reduce((n, s) => n + estimateTokens(renderSource(s, { style: 'seconds' }).block), 0);
  let answer: JsonAnswer;
  let messages: ChatMessage[];
  if (total <= budget) {
    messages = extractMessages(set.sources, { schema, template, question: opts.question, custom });
    answer = await chatJson(deps.registry, { step: 'extract', messages, chain, maxTokens: opts.maxOutputTokens }, ledger, deps.ctx);
  } else {
    ({ answer, messages } = await extractInParts(set, { schema, template, custom, budget }, c));
  }

  const { value, repaired } = await validated(answer, messages, schema, c);
  const verified = verifyExtraction(value, set);
  return {
    ...(template ? { template: template.id } : {}),
    data: custom ? (verified.data as Record<string, unknown>).data : verified.data,
    citations: verified.citations,
    unverified: verified.unverified,
    repaired,
    sources: set.sources.map((s) => s.summary),
    rungs: ledger.rungs,
    attempts: ledger.attempts,
    notes: ledger.notes,
    createdAt: new Date().toISOString(),
  };
}

async function extractInParts(
  set: SourceSet,
  p: { schema: JsonSchema; template?: Template; custom: boolean; budget: number },
  c: { deps: InsightsDeps; ledger: Ledger; opts: ExtractOptions },
): Promise<{ answer: JsonAnswer; messages: ChatMessage[] }> {
  const partials: string[] = [];
  let lastErr: unknown;
  for (const s of set.sources) {
    const chunks = chunkLines(s.lines, p.budget);
    for (const [i, lines] of chunks.entries()) {
      const messages = extractMessages([s], {
        schema: p.schema,
        template: p.template,
        question: c.opts.question,
        custom: p.custom,
        parts: new Map([[s, { lines, index: i, total: chunks.length }]]),
      });
      try {
        const res = await chatJson(
          c.deps.registry,
          { step: 'map', messages, chain: c.opts.chain, maxTokens: c.opts.maxOutputTokens, videoId: s.summary.videoId, chunk: i },
          c.ledger,
          c.deps.ctx,
        );
        if (res.value) partials.push(JSON.stringify(res.value));
        else c.ledger.notes.push(`Part ${i + 1} of ${s.summary.videoId} returned no JSON.`);
      } catch (err) {
        lastErr = err;
        c.ledger.notes.push(`Part ${i + 1} of ${s.summary.videoId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (partials.length === 0) {
    throw Object.assign(
      new Vid2ContextError('all-rungs-failed', 'Every extraction part failed.', {
        hint: 'See `attempts`. Adding a free key (docs/providers.md) adds more rungs, or use extractPrompt for agent-side extraction.',
      }),
      { attempts: [...c.ledger.attempts, ...attemptsOf(lastErr)] },
    );
  }
  const messages = mergeMessages(partials.map((x, i) => `Part ${i + 1}:\n${x}`).join('\n\n'), {
    schema: p.schema,
    question: c.opts.question,
  });
  const answer = await chatJson(
    c.deps.registry,
    { step: 'reduce', messages, chain: c.opts.chain, maxTokens: c.opts.maxOutputTokens },
    c.ledger,
    c.deps.ctx,
  );
  return { answer, messages };
}
