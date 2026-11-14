/**
 * Citations suite: do cited answers and briefs point at the right second?
 *
 * For every question in citations.json, over the collection's recorded
 * transcripts, two producers run through the free-first LLM chain:
 *
 *   ask    @vid2context/ask: a grounded answer with [n] citations
 *   brief  @vid2context/insights: a cited brief for the question
 *
 * Every citation they return is checked independently with `checkCitation`
 * (the quote must occur within 30 s of its time). A question counts as a hit
 * when at least one citation lands within 30 s of a labeled answer place.
 * Citations a producer rejected itself (unverified brief claims, [n] refs
 * that match no source) are counted separately.
 */
import { ask } from '@vid2context/ask';
import { MemoryStorage, type Segment, type VideoContext } from '@vid2context/core';
import { buildBrief } from '@vid2context/insights';
import { type CitationQuestion, datasetLabel, datasetPath, loadCitationsDataset } from '../dataset.ts';
import { checkCitation } from '../metrics/citations.ts';
import type { ItemResult } from '../results.ts';
import { loadCollection, stageMs } from './collection.ts';
import { errorInfo, limited, type SuiteContext } from './common.ts';
import type { SuiteOutput } from './stt.ts';

export const TOLERANCE_SEC = 30;

interface Cited {
  videoId: string;
  startSec: number;
  quote?: string;
}

/** Score one producer's citations for one question. */
export function scoreCitations(
  q: CitationQuestion,
  cited: readonly Cited[],
  rejected: number,
  transcripts: ReadonlyMap<string, readonly Segment[]>,
): NonNullable<ItemResult['citations']> {
  const verified = cited.filter(
    (c) =>
      c.quote !== undefined &&
      checkCitation(transcripts.get(c.videoId) ?? [], { atSec: c.startSec, quote: c.quote }, { toleranceSec: TOLERANCE_SEC }).ok,
  ).length;
  const hit = cited.some((c) =>
    q.expected.some(
      (e) => e.videoId === c.videoId && c.startSec >= e.startSec - TOLERANCE_SEC && c.startSec <= e.endSec + TOLERANCE_SEC,
    ),
  );
  return { total: cited.length, verified, hit, rejected };
}

async function runProducer(
  name: 'ask' | 'brief',
  q: CitationQuestion,
  contexts: VideoContext[],
  sc: SuiteContext,
): Promise<{ cited: Cited[]; rejected: number; rung: string; attempts: ItemResult['attempts'] }> {
  if (name === 'ask') {
    const res = await ask(sc.registry, { question: q.question, contexts, storage: new MemoryStorage() }, sc.ctx);
    return {
      cited: res.citations.map((c) => ({ videoId: c.videoId, startSec: c.startSec, quote: c.quote })),
      rejected: res.unverified.length,
      rung: res.rung,
      attempts: res.attempts,
    };
  }
  const brief = await buildBrief(contexts, { question: q.question }, { registry: sc.registry, ctx: sc.ctx });
  return {
    cited: brief.claims.map((c) => ({ videoId: c.citation.videoId, startSec: c.citation.startSec, quote: c.citation.quote })),
    rejected: brief.unverified.length,
    rung: [...new Set(brief.rungs.map((r) => r.rung))].join(', '),
    attempts: brief.attempts,
  };
}

export async function runCitationsSuite(sc: SuiteContext): Promise<SuiteOutput> {
  const path = datasetPath(sc.dataset ?? 'citations.json');
  const data = loadCitationsDataset(path);
  const contexts = loadCollection(data.collection);
  const transcripts = new Map(contexts.map((c) => [c.metadata.ref.id, c.transcript.segments]));
  const questions = limited(data.questions, sc.limit);
  const items: ItemResult[] = [];
  for (const name of ['ask', 'brief'] as const) {
    for (const q of questions) {
      const base = {
        item: q.id,
        videoId: q.expected[0]?.videoId ?? '',
        language: contexts[0]?.transcript.language ?? 'en',
        rung: name,
      };
      const started = Date.now();
      try {
        const res = await runProducer(name, q, contexts, sc);
        items.push({
          ...base,
          outcome: 'ok',
          detail: res.rung,
          citations: scoreCitations(q, res.cited, res.rejected, transcripts),
          latencyMs: stageMs(res.attempts ?? [], 'llm'),
          wallMs: Date.now() - started,
          attempts: res.attempts,
        });
      } catch (err) {
        items.push({ ...base, outcome: 'error', ...errorInfo(err), wallMs: Date.now() - started });
      }
    }
  }
  const evaluated = new Set(items.filter((i) => i.outcome === 'ok').map((i) => i.item)).size;
  const answering = [...new Set(items.map((i) => i.detail).filter((d): d is string => Boolean(d)))];
  return {
    dataset: { file: datasetLabel(path), items: questions.length, evaluated },
    skippedRungs: [],
    notes: answering.length > 0 ? [`LLM rungs that answered: ${answering.join('; ')}.`] : [],
    items,
    rungs: ['ask', 'brief'],
  };
}
