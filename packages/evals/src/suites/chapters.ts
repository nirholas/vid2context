/**
 * Chapters suite: how well @vid2context/chapters finds chapter boundaries.
 *
 * Each item is a recorded VideoContext whose video already has chapters:
 * creator chapters (timestamps in the description) or YouTube's own key
 * moments. The suite hides those chapters and the description, runs
 * `autoChapters` on the transcript alone, and scores the predicted chapter
 * starts against the hidden ones within plus or minus `toleranceSec`.
 *
 * Rows:
 *   baseline/uniform     the same number of chapters as the offline result,
 *                        evenly spaced; what segmentation has to beat
 *   chapters/texttiling  the offline segmenter (no model, no network)
 *   chapters/llm         offline boundaries refined by the default free-first
 *                        LLM chain, or chapters/llm:<id> per rung named with
 *                        --rungs, each pinned with the chain option `only`
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { autoChapters, OFFLINE_PRODUCER } from '@vid2context/chapters';
import { attemptsOf, type Ctx, type Registry, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { type ChapterReferenceKind, type ChaptersItem, datasetLabel, datasetPath, loadChaptersDataset } from '../dataset.ts';
import { boundaryAgreement } from '../metrics/chapters.ts';
import type { ItemResult } from '../results.ts';
import { selectLlmRungs } from './cleanup.ts';
import { REPO_ROOT, stageMs } from './collection.ts';
import { errorInfo, limited, type SuiteContext } from './common.ts';
import type { SuiteOutput } from './stt.ts';

export const UNIFORM_BASELINE = 'baseline/uniform';
export const LLM_PRODUCER = 'chapters/llm';

/** `metadata.extra.chapterSource` values (set by the YouTube provider) for each reference kind. */
const SOURCES: Record<ChapterReferenceKind, string[]> = {
  'creator-chapters': ['description', 'markers'],
  'key-moments': ['key-moments'],
};

/** Load an item's recorded context and check it holds the reference the dataset says it does. */
export function loadChaptersContext(item: ChaptersItem, root: string = REPO_ROOT): VideoContext {
  const context = JSON.parse(readFileSync(resolve(root, item.context), 'utf8')) as VideoContext;
  const source = String(context.metadata.extra?.chapterSource ?? '');
  const hint = 'Point the item at a recorded VideoContext whose metadata.chapters came from the source named in "reference".';
  if (!SOURCES[item.reference].includes(source)) {
    throw new Vid2ContextError(
      'bad-request',
      `${item.context} has chapters from "${source || 'nowhere'}", not ${item.reference}.`,
      { hint },
    );
  }
  if ((context.metadata.chapters?.length ?? 0) < 2) {
    throw new Vid2ContextError('bad-request', `${item.context} has fewer than two reference chapters.`, { hint });
  }
  return context;
}

/** The context with its chapters and description removed, so no producer can see the answer. */
export function blind(context: VideoContext): VideoContext {
  const extra = { ...(context.metadata.extra ?? {}) };
  delete extra.chapterSource;
  return { ...context, metadata: { ...context.metadata, chapters: [], description: undefined, extra } };
}

/** `n` evenly spaced chapter starts over `durationSec`, the first at 0. */
export function uniformStarts(n: number, durationSec: number): number[] {
  return Array.from({ length: Math.max(1, n) }, (_, i) => Math.round(((i * durationSec) / Math.max(1, n)) * 10) / 10);
}

function scored(
  item: ChaptersItem,
  context: VideoContext,
  rung: string,
  starts: number[],
  toleranceSec: number,
): ItemResult & { chapters: NonNullable<ItemResult['chapters']> } {
  const reference = (context.metadata.chapters ?? []).map((c) => c.startSec);
  return {
    item: item.id,
    videoId: context.metadata.ref.id,
    language: context.transcript.language,
    rung,
    outcome: 'ok',
    chapters: { ...boundaryAgreement(reference, starts, toleranceSec), referenceKind: item.reference, starts },
  };
}

/**
 * Score the offline producers (uniform baseline and TextTiling) on one item.
 * No network and deterministic, so the unit tests run this exact path on the
 * recorded contexts.
 */
export async function scoreOffline(
  registry: Registry,
  item: ChaptersItem,
  context: VideoContext,
  toleranceSec: number,
  ctx: Ctx,
): Promise<ItemResult[]> {
  const started = performance.now();
  const offline = await autoChapters(registry, blind(context), { llm: false, force: true }, ctx);
  const ms = performance.now() - started;
  const starts = offline.chapters.map((c) => c.startSec);
  return [
    { ...scored(item, context, UNIFORM_BASELINE, uniformStarts(starts.length, offline.durationSec), toleranceSec), costUsd: 0 },
    {
      ...scored(item, context, OFFLINE_PRODUCER, starts, toleranceSec),
      latencyMs: ms,
      wallMs: ms,
      costUsd: 0,
    },
  ];
}

export async function runChaptersSuite(sc: SuiteContext): Promise<SuiteOutput> {
  const path = datasetPath(sc.dataset ?? 'chapters.json');
  const data = loadChaptersDataset(path);
  const items = limited(data.items, sc.limit);
  const { rungs, skipped } = selectLlmRungs(sc);
  const pinned = Boolean(sc.rungs && sc.rungs.length > 0);
  const llmRows: { name: string; only?: string[] }[] = pinned
    ? rungs.map((r) => ({ name: `${LLM_PRODUCER}:${r.id}`, only: [r.id] }))
    : [{ name: LLM_PRODUCER }];
  const tiers = new Map(sc.registry.llmRungs(sc.ctx.env).map((r) => [r.id, r.tier]));
  const results: ItemResult[] = [];
  const notes: string[] = [];
  const fellBack: string[] = [];
  let answered = 0;
  let moved = 0;

  for (const item of items) {
    let context: VideoContext;
    let offlineStarts: number[] = [];
    try {
      context = loadChaptersContext(item);
      const offline = await scoreOffline(sc.registry, item, context, data.toleranceSec, sc.ctx);
      offlineStarts = offline.find((r) => r.rung === OFFLINE_PRODUCER)?.chapters?.starts ?? [];
      results.push(...offline);
    } catch (err) {
      results.push({
        item: item.id,
        videoId: item.url,
        language: item.language,
        rung: OFFLINE_PRODUCER,
        outcome: 'error',
        ...errorInfo(err),
      });
      continue;
    }
    for (const row of llmRows) {
      const started = Date.now();
      try {
        const res = await autoChapters(
          sc.registry,
          blind(context),
          { force: true, chain: row.only ? { only: row.only, allowPaid: true } : {} },
          sc.ctx,
        );
        const usedLlm = res.method === 'texttiling+llm';
        if (!usedLlm) fellBack.push(`${row.name} on ${item.id}: ${res.notes[0] ?? 'no LLM answer'}`);
        else {
          answered++;
          moved += res.chapters.filter((c, i) => c.startSec !== offlineStarts[i]).length;
        }
        const tier = res.rung ? tiers.get(res.rung) : undefined;
        const base = scored(
          item,
          context,
          row.name,
          res.chapters.map((c) => c.startSec),
          data.toleranceSec,
        );
        results.push({
          ...base,
          tier,
          chapters: { ...base.chapters, method: res.method },
          detail: usedLlm ? `${res.rung}${res.model ? ` (${res.model})` : ''}` : res.notes[0],
          latencyMs: stageMs(res.attempts, 'llm'),
          wallMs: Date.now() - started,
          // autoChapters does not report token usage, so a paid rung cannot be priced.
          costUsd: tier === 'paid' ? null : 0,
          attempts: res.attempts,
        });
      } catch (err) {
        results.push({
          item: item.id,
          videoId: context.metadata.ref.id,
          language: context.transcript.language,
          rung: row.name,
          outcome: 'error',
          ...errorInfo(err),
          wallMs: Date.now() - started,
          attempts: attemptsOf(err),
        });
      }
    }
  }
  for (const f of fellBack) notes.push(`Kept the offline boundaries for ${f}`);
  if (answered > 0) {
    notes.push(
      `The LLM answered on ${answered} item run${answered === 1 ? '' : 's'} and moved ${moved} boundar${moved === 1 ? 'y' : 'ies'} away from the offline ones.`,
    );
  }
  if (pinned && rungs.length === 0) notes.push('No named LLM rung is enabled, so only the offline rows were scored.');
  const evaluated = new Set(results.filter((r) => r.outcome === 'ok').map((r) => r.item)).size;
  const rungIds = [UNIFORM_BASELINE, OFFLINE_PRODUCER, ...llmRows.map((r) => r.name)];
  return {
    dataset: { file: datasetLabel(path), items: items.length, evaluated },
    skippedRungs: skipped,
    notes,
    items: results,
    rungs: rungIds,
  };
}
