/**
 * Cleanup suite: how much core caption cleanup (prompt 02) improves raw
 * platform auto-captions, scored against the creator captions of the same
 * video.
 *
 * Each video gets one row per cleanup variant, all from the same raw input:
 *
 *   raw              the auto-caption track as served (the baseline)
 *   clean:rules      `cleanTranscript` rule-based steps: caption
 *                    normalization, rolling-duplicate folding, sentence
 *                    restoration
 *   clean:fillers    the same plus filler removal (um, uh)
 *   clean:llm:<id>   the rule-based steps plus the LLM punctuation pass,
 *                    pinned to one LLM rung (`--rungs`), or `clean:llm` on
 *                    the default free-first chain when no rung is named
 *
 * Per variant: WER and CER (cleanup must not change what was said, so these
 * should stay at the raw level), punctuation and capitalization F1 (what
 * cleanup is for), word timing, and for the LLM pass its latency and how
 * many chunks were accepted, rejected (the model changed words, so the
 * original was kept) or failed. The raw track is never replaced: every
 * variant is an added layer scored next to it.
 */
import {
  attemptsOf,
  type CleanReport,
  type CleanTranscriptOptions,
  cleanTranscript,
  isRungEnabled,
  keylessAllowed,
  type LlmRung,
  type Transcript,
} from '@vid2context/core';
import { datasetLabel, datasetPath, loadVideoDataset } from '../dataset.ts';
import type { RecordedRef } from '../refs.ts';
import type { ItemResult, SkippedRung } from '../results.ts';
import { scoreCaptions } from './captions.ts';
import { autoReference, creatorReference, errorInfo, limited, referenceFailure, type SuiteContext } from './common.ts';
import type { SuiteOutput } from './stt.ts';

export const RAW_VARIANT = 'raw';
export const RULES_VARIANT = 'clean:rules';
export const FILLERS_VARIANT = 'clean:fillers';
export const LLM_VARIANT = 'clean:llm';

/** A recorded auto-caption reference as the Transcript cleanup takes. */
export function refTranscript(rec: RecordedRef, url: string): Transcript {
  const [platform = 'youtube', nativeId = rec.videoId] = rec.videoId.split(':');
  return {
    ref: { input: url, platform, kind: 'video', id: rec.videoId, nativeId, url },
    language: rec.language,
    origin: rec.origin,
    producer: rec.producer,
    segments: rec.segments,
    createdAt: `${rec.recordedAt}T00:00:00.000Z`,
  };
}

/** What a cleanup run did, kept on each result row. */
export function cleanupStats(report: CleanReport): NonNullable<ItemResult['cleanup']> {
  return {
    steps: report.steps,
    merged: report.merged,
    removed: report.removed,
    rewritten: report.rewritten,
    ...(report.llm
      ? {
          llm: {
            chunks: report.llm.chunks,
            accepted: report.llm.accepted,
            rejected: report.llm.rejected,
            failed: report.llm.failed,
            rungs: report.llm.rungs,
          },
        }
      : {}),
  };
}

/**
 * Score the offline variants (raw, rules, rules plus fillers) of one item.
 * Exported so the unit tests run the exact scoring on recorded tracks.
 */
export async function scoreOfflineVariants(
  item: { id: string; language: string; url: string },
  videoId: string,
  creator: RecordedRef,
  auto: RecordedRef,
): Promise<ItemResult[]> {
  const input = refTranscript(auto, item.url);
  const rows: ItemResult[] = [scoreCaptions(item, videoId, RAW_VARIANT, creator.segments, auto.segments)];
  const variants: [string, CleanTranscriptOptions][] = [
    [RULES_VARIANT, { sentences: true }],
    [FILLERS_VARIANT, { sentences: true, fillers: true }],
  ];
  for (const [name, opts] of variants) {
    const { transcript, report } = await cleanTranscript(input, opts);
    rows.push({
      ...scoreCaptions(item, videoId, name, creator.segments, transcript.segments),
      cleanup: cleanupStats(report),
    });
  }
  return rows;
}

/**
 * LLM rungs for the LLM variant. With --rungs: each named rung that is
 * enabled (paid included when named). Without: none pinned, so the variant
 * runs once on the default free-first chain.
 */
export function selectLlmRungs(sc: SuiteContext): { rungs: LlmRung[]; skipped: SkippedRung[] } {
  const env = sc.ctx.env;
  const skipped: SkippedRung[] = [];
  if (!sc.rungs || sc.rungs.length === 0) return { rungs: [], skipped };
  const all = sc.registry.llmRungs(env);
  const picked: LlmRung[] = [];
  for (const name of sc.rungs) {
    const matches = all.filter((r) => r.id === name || r.service === name || r.provider === name);
    if (matches.length === 0) skipped.push({ rung: name, reason: 'unknown rung (not in the installed llm providers)' });
    for (const r of matches) {
      if (picked.includes(r)) continue;
      if (!isRungEnabled(r, env)) skipped.push({ rung: r.id, reason: 'not enabled (missing key)', envVars: r.requires });
      else if (r.tier === 'keyless' && !keylessAllowed(env))
        skipped.push({ rung: r.id, reason: 'keyless rungs are off (VID2CONTEXT_KEYLESS=0)' });
      else picked.push(r);
    }
  }
  return { rungs: picked, skipped };
}

export async function runCleanupSuite(sc: SuiteContext): Promise<SuiteOutput> {
  const path = datasetPath(sc.dataset ?? 'captions.json');
  const dataset = loadVideoDataset(path);
  const items = limited(dataset.items, sc.limit);
  const { rungs, skipped } = selectLlmRungs(sc);
  const llmVariants: { name: string; only?: string[] }[] =
    sc.rungs && sc.rungs.length > 0
      ? rungs.map((r) => ({ name: `${LLM_VARIANT}:${r.id}`, only: [r.id] }))
      : [{ name: LLM_VARIANT }];
  const results: ItemResult[] = [];
  const notes: string[] = [];

  for (const item of items) {
    let videoId = item.url;
    try {
      const { ref } = sc.registry.resolve(item.url);
      videoId = ref.id;
      const creator = await creatorReference(sc, item, ref);
      const auto = creator ? await autoReference(sc, item, ref) : null;
      if (!creator || !auto) {
        const reason = creator ? 'no-auto-captions' : 'no-creator-captions';
        results.push({ item: item.id, videoId, language: item.language, rung: RAW_VARIANT, outcome: 'skipped', reason });
        continue;
      }
      results.push(...(await scoreOfflineVariants(item, videoId, creator, auto)));
      for (const v of llmVariants) {
        const started = Date.now();
        try {
          const { transcript, report } = await cleanTranscript(refTranscript(auto, item.url), {
            sentences: true,
            llm: { registry: sc.registry, ctx: sc.ctx, chain: v.only ? { only: v.only, allowPaid: true } : {} },
          });
          const attempts = report.llm?.attempts ?? [];
          results.push({
            ...scoreCaptions(item, videoId, v.name, creator.segments, transcript.segments),
            latencyMs: attempts.filter((a) => a.outcome === 'ok').reduce((s, a) => s + (a.ms ?? 0), 0),
            wallMs: Date.now() - started,
            costUsd: 0,
            cleanup: cleanupStats(report),
            attempts,
          });
        } catch (err) {
          results.push({
            item: item.id,
            videoId,
            language: item.language,
            rung: v.name,
            outcome: 'error',
            ...errorInfo(err),
            wallMs: Date.now() - started,
            attempts: attemptsOf(err),
          });
        }
      }
    } catch (err) {
      results.push({
        item: item.id,
        videoId,
        language: item.language,
        rung: RAW_VARIANT,
        outcome: 'error',
        ...referenceFailure(err),
        attempts: attemptsOf(err),
      });
    }
  }
  for (const r of results) {
    const llm = r.cleanup?.llm;
    if (llm && llm.accepted < llm.chunks) {
      notes.push(
        `${r.rung} on ${r.item}: ${llm.accepted} of ${llm.chunks} LLM chunks applied (${llm.rejected} rejected because the model changed words, ${llm.failed} failed); the rule-based text was kept for the rest.`,
      );
    }
  }
  if (results.some((r) => r.reason === 'no-auto-captions')) {
    notes.push('Items whose video has no auto-caption track in the item language were skipped.');
  }
  const evaluated = new Set(results.filter((r) => r.outcome === 'ok').map((r) => r.item)).size;
  return {
    dataset: { file: datasetLabel(path), items: items.length, evaluated },
    skippedRungs: skipped,
    notes,
    items: results,
    rungs: [RAW_VARIANT, RULES_VARIANT, FILLERS_VARIANT, ...llmVariants.map((v) => v.name)],
  };
}
