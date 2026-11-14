/**
 * buildBrief(): server-side cited brief over one or many videos.
 *
 *   fits one call?  yes -> single pass: claims and their topics in one answer
 *                   no  -> map: each video (chunked by budget at line
 *                          boundaries) into claims JSON
 *                          reduce: claims grouped by normalized topic, then an
 *                          LLM merges topics and groups claims into points
 *   verify          every claim's quote is checked against the transcript
 *                   (verify.ts) before it can back a point
 *   classify        consensus (two or more distinct videos support a point,
 *                   none oppose), disagreement (claims on both sides), or
 *                   single-source
 *
 * Calls run one at a time so keyless lanes stay under their per-minute limits
 * and the run is reproducible. The map step uses the caller's chain (free
 * first, small fast models); the reduce step defaults to policy 'quality'.
 */
import { type ChainOptions, type Ctx, estimateTokens, type Registry, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { chatJson, Ledger, sourceBudget, withJson } from './llm.ts';
import { renderBrief } from './markdown.ts';
import { mapMessages, reduceMessages, singleMessages } from './prompts.ts';
import { renderSource, type Source, sourceSet } from './sources.ts';
import { getTemplate, type Template } from './templates/index.ts';
import { chunkLines, topicKey } from './text.ts';
import type { Brief, BriefOptions, Citation, Claim, Point, RawClaim, UnverifiedClaim } from './types.ts';
import { verifyCitations } from './verify.ts';

export interface InsightsDeps {
  registry: Registry;
  ctx: Ctx;
}

/** Claims asked for per map call, and per single pass. */
const CLAIMS_PER_CHUNK = 25;
const CLAIMS_SINGLE = 40;

function asRawClaims(v: unknown): (RawClaim & { id?: string })[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is RawClaim & { id?: string } =>
      !!c && typeof c === 'object' && typeof (c as RawClaim).claim === 'string' && (c as RawClaim).claim.trim() !== '',
  );
}

interface RawPoint {
  statement: string;
  support: string[];
  counter?: string;
  oppose: string[];
}
interface RawTopic {
  topic: string;
  points: RawPoint[];
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()) : []);

function asTopics(v: unknown): RawTopic[] | null {
  if (!Array.isArray(v)) return null;
  const out: RawTopic[] = [];
  for (const t of v) {
    if (!t || typeof t !== 'object') continue;
    const topic = typeof (t as RawTopic).topic === 'string' ? (t as RawTopic).topic.trim() : '';
    const points = Array.isArray((t as RawTopic).points) ? (t as RawTopic).points : [];
    out.push({
      topic: topic || 'general',
      points: points
        .filter((p) => p && typeof p === 'object' && typeof p.statement === 'string')
        .map((p) => ({
          statement: p.statement.trim(),
          support: ids(p.support),
          oppose: ids(p.oppose),
          ...(typeof p.counter === 'string' && p.counter.trim() ? { counter: p.counter.trim() } : {}),
        })),
    });
  }
  return out;
}

/**
 * Turn the LLM's topics and points into classified points over verified
 * claims only. Ids the model invented or reused are dropped; verified claims
 * no point mentions become single-source points of their own, so nothing
 * verified is lost.
 */
export function classify(topics: RawTopic[], claims: Claim[], idMap?: Map<string, string>): Point[] {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const used = new Set<string>();
  const take = (raw: string[]): Claim[] => {
    const out: Claim[] = [];
    for (const r of raw) {
      const id = idMap ? idMap.get(r) : r;
      const c = id ? byId.get(id) : undefined;
      if (!c || used.has(c.id)) continue;
      used.add(c.id);
      out.push(c);
    }
    return out;
  };
  const points: Point[] = [];
  const add = (topic: string, statement: string, support: Claim[], oppose: Claim[], counter?: string) => {
    if (support.length === 0 && oppose.length > 0) {
      [support, oppose] = [oppose, support];
      statement = counter ?? support[0]?.claim ?? statement;
      counter = undefined;
    }
    if (support.length === 0) return;
    const videos = [...new Set([...support, ...oppose].map((c) => c.videoId))];
    const supportVideos = new Set(support.map((c) => c.videoId));
    const kind = oppose.length > 0 ? 'disagreement' : supportVideos.size >= 2 ? 'consensus' : 'single-source';
    points.push({
      topic,
      kind,
      statement,
      ...(oppose.length > 0 ? { counter: counter ?? oppose.map((c) => c.claim).join(' ') } : {}),
      support: support.map((c) => c.citation),
      oppose: oppose.map((c) => c.citation),
      videos,
      claimIds: { support: support.map((c) => c.id), oppose: oppose.map((c) => c.id) },
    });
  };
  for (const t of topics) {
    for (const p of t.points) add(t.topic, p.statement, take(p.support), take(p.oppose), p.counter);
  }
  for (const c of claims) {
    if (!used.has(c.id)) {
      used.add(c.id);
      add(c.topic, c.claim, [c], []);
    }
  }
  // One display name per normalized topic: the first spelling seen.
  const names = new Map<string, string>();
  for (const p of points) {
    const k = topicKey(p.topic);
    if (!names.has(k)) names.set(k, p.topic);
    p.topic = names.get(k) as string;
  }
  return points;
}

function claimLine(c: Claim, labelOf: (videoId: string) => string): string {
  const one = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  return `${c.id} | ${labelOf(c.videoId)} | ${one(c.topic)} | ${one(c.stance ?? '')} | ${one(c.claim)}`;
}

/** Group claims by normalized topic and pack the groups into batches that fit the budget. */
function reduceBatches(claims: Claim[], budget: number, labelOf: (id: string) => string): string[] {
  const groups = new Map<string, Claim[]>();
  for (const c of claims) {
    const k = topicKey(c.topic);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const batches: string[] = [];
  let cur: string[] = [];
  let used = 0;
  for (const group of [...groups.values()].sort((a, b) => b.length - a.length)) {
    const lines = group.map((c) => claimLine(c, labelOf));
    const t = estimateTokens(lines.join('\n'));
    if (cur.length > 0 && used + t > budget) {
      batches.push(cur.join('\n'));
      cur = [];
      used = 0;
    }
    cur.push(...lines);
    used += t;
  }
  if (cur.length > 0) batches.push(cur.join('\n'));
  return batches;
}

/** Reduce chain: the caller's own reduce options, else the map chain with policy 'quality' unless a policy is already chosen. */
function reduceChainFor(opts: BriefOptions, ctx: Ctx): ChainOptions {
  if (opts.reduceChain) return opts.reduceChain;
  const chain = opts.chain ?? {};
  if (chain.policy || ctx.env.VID2CONTEXT_POLICY) return chain;
  return { ...chain, policy: 'quality' };
}

async function reduce(
  claims: Claim[],
  ctx: { deps: InsightsDeps; ledger: Ledger; template: Template; opts: BriefOptions; budget: number; labelOf: (id: string) => string },
): Promise<RawTopic[]> {
  if (claims.length === 0) return [];
  const topics: RawTopic[] = [];
  const batches = reduceBatches(claims, ctx.budget, ctx.labelOf);
  for (const [i, block] of batches.entries()) {
    const messages = reduceMessages(block, { template: ctx.template, question: ctx.opts.question });
    try {
      const res = await chatJson(
        ctx.deps.registry,
        { step: 'reduce', messages, chain: reduceChainFor(ctx.opts, ctx.deps.ctx), maxTokens: ctx.opts.maxOutputTokens, chunk: i },
        ctx.ledger,
        ctx.deps.ctx,
      );
      const parsed = asTopics(res.value?.topics);
      if (parsed) topics.push(...parsed);
      else ctx.ledger.notes.push(`Reduce batch ${i + 1} returned no usable topics; its claims are listed as single-source.`);
    } catch (err) {
      ctx.ledger.notes.push(
        `Reduce batch ${i + 1} failed (${err instanceof Error ? err.message : String(err)}); its claims are listed as single-source, grouped by topic name.`,
      );
    }
  }
  return topics;
}

/** Build a cited brief on the server with the LLM chain. Every claim in the result is verified against its transcript. */
export async function buildBrief(contexts: VideoContext[], opts: BriefOptions, deps: InsightsDeps): Promise<Brief> {
  const set = sourceSet(contexts);
  const template = getTemplate(opts.template);
  const ledger = new Ledger();
  const chain = withJson(opts.chain);
  const budget = sourceBudget(deps.registry, deps.ctx, chain, opts);
  const labelOf = (videoId: string) => set.find(videoId)?.label ?? videoId;

  const rendered = set.sources.map((s) => renderSource(s, { style: 'seconds' }).block);
  const total = rendered.reduce((n, b) => n + estimateTokens(b), 0);

  let raw: (RawClaim & { id?: string })[] = [];
  let topics: RawTopic[] | null = null;
  let strategy: Brief['strategy'];

  const progress = opts.onProgress ?? (() => {});
  if (total <= budget) {
    strategy = 'single';
    progress({ done: 0, total: 1, message: `Reading ${set.sources.length} video(s) in one pass` });
    const messages = singleMessages(rendered, { template, question: opts.question, maxClaims: CLAIMS_SINGLE });
    const res = await chatJson(deps.registry, { step: 'single', messages, chain, maxTokens: opts.maxOutputTokens }, ledger, deps.ctx);
    raw = asRawClaims(res.value?.claims);
    topics = asTopics(res.value?.topics);
  } else {
    strategy = 'map-reduce';
    const plan = set.sources.map((s) => chunkLines(s.lines, budget).length);
    const steps = plan.reduce((a, b) => a + b, 0) + 1;
    let done = 0;
    for (const s of set.sources) {
      raw.push(
        ...(await mapSource(s, {
          deps,
          ledger,
          template,
          opts,
          chain,
          budget,
          tick: (message) => progress({ done: done++, total: steps, message }),
        })),
      );
    }
    progress({ done, total: steps, message: 'Merging claims into topics' });
  }

  if (strategy === 'map-reduce' && raw.length === 0 && !ledger.rungs.some((r) => r.step === 'map')) {
    throw Object.assign(
      new Vid2ContextError('all-rungs-failed', 'Every map step failed, so there are no claims to build a brief from.', {
        hint: 'See `attempts` for each failure. Adding a free key (docs/providers.md) adds more rungs, or use briefPrompt for agent-side synthesis.',
      }),
      { attempts: ledger.attempts },
    );
  }

  const { verified, unverified, ids: verifiedIds } = verifyCitations(raw, set);
  let idMap: Map<string, string> | undefined;
  if (strategy === 'single' && topics) {
    // The single pass's points reference the model's own ids (k1, ...); map them to verified ids.
    idMap = new Map();
    raw.forEach((r, i) => {
      const v = verifiedIds[i];
      if (v && typeof r.id === 'string') idMap?.set(r.id.trim(), v);
    });
  }
  if (!topics || (strategy === 'single' && topics.every((t) => t.points.length === 0))) {
    topics = await reduce(verified, { deps, ledger, template, opts, budget, labelOf });
    idMap = undefined;
  } else if (strategy === 'map-reduce') {
    topics = await reduce(verified, { deps, ledger, template, opts, budget, labelOf });
  }

  const points = classify(topics, verified, idMap);
  const brief: Brief = {
    ...(opts.question ? { question: opts.question } : {}),
    template: template.id,
    strategy,
    markdown: '',
    claims: verified,
    consensus: points.filter((p) => p.kind === 'consensus'),
    disagreements: points.filter((p) => p.kind === 'disagreement'),
    singleSource: points.filter((p) => p.kind === 'single-source'),
    unverified,
    sources: set.sources.map((s) => s.summary),
    rungs: ledger.rungs,
    attempts: ledger.attempts,
    notes: ledger.notes,
    createdAt: new Date().toISOString(),
  };
  brief.markdown = renderBrief(brief, template, points);
  return brief;
}

async function mapSource(
  s: Source,
  c: {
    deps: InsightsDeps;
    ledger: Ledger;
    template: Template;
    opts: BriefOptions;
    chain: ChainOptions;
    budget: number;
    tick: (message: string) => void;
  },
): Promise<RawClaim[]> {
  const chunks = chunkLines(s.lines, c.budget);
  const out: RawClaim[] = [];
  for (const [i, lines] of chunks.entries()) {
    c.tick(`Reading ${s.summary.title} (part ${i + 1} of ${chunks.length})`);
    const { block } = renderSource(s, { style: 'seconds', lines, part: { index: i, total: chunks.length } });
    const messages = mapMessages(block, { template: c.template, question: c.opts.question, maxClaims: CLAIMS_PER_CHUNK });
    try {
      const res = await chatJson(
        c.deps.registry,
        { step: 'map', messages, chain: c.chain, maxTokens: c.opts.maxOutputTokens, videoId: s.summary.videoId, chunk: i },
        c.ledger,
        c.deps.ctx,
      );
      const claims = asRawClaims(res.value?.claims);
      // A chunk only covers one video: a claim tagged with another label is the model's slip, so pin it to this one.
      out.push(...claims.map((cl) => ({ ...cl, videoId: s.label })));
      if (!res.value) c.ledger.notes.push(`Map step for ${s.summary.videoId} part ${i + 1} returned no JSON; its claims are missing.`);
    } catch (err) {
      c.ledger.notes.push(
        `Map step for ${s.summary.videoId} part ${i + 1} failed (${err instanceof Error ? err.message : String(err)}); its claims are missing.`,
      );
    }
  }
  return out;
}

export type { Citation, UnverifiedClaim };
