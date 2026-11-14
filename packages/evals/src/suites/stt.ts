/**
 * Speech-to-text suite: word error rate per rung against creator captions.
 *
 * For every dataset video: get the creator-caption reference, get the audio
 * once (cached), then transcribe it with each selected rung pinned on its own
 * (chain option `only`), through core's `transcribeLong` so rungs with short
 * upload limits (OVH keyless accepts 60 s) receive split audio exactly as the
 * product would send it. Rate limits are waited out by `transcribeLong`.
 */
import { attemptsOf, clearCooldowns, transcribeLong } from '@vid2context/core';
import { loadVideoDataset } from '../dataset.ts';
import { costOf } from '../metrics/cost.ts';
import { timingError } from '../metrics/timing.ts';
import { characterErrorRate, wordErrorRate } from '../metrics/wer.ts';
import { textOf } from '../refs.ts';
import type { EvalResult, ItemResult } from '../results.ts';
import { audioFor, creatorReference, errorInfo, limited, type SuiteContext, selectSttRungs } from './common.ts';

export type SuiteOutput = Pick<EvalResult, 'dataset' | 'skippedRungs' | 'notes' | 'items'> & { rungs: string[] };

export async function runSttSuite(sc: SuiteContext, file = 'stt.json'): Promise<SuiteOutput> {
  const dataset = loadVideoDataset(file);
  const items = limited(dataset.items, sc.limit);
  const { rungs, skipped } = selectSttRungs(sc);
  const notes: string[] = [];
  const results: ItemResult[] = [];
  if (rungs.length === 0) notes.push('No speech-to-text rung is enabled, so nothing was transcribed.');

  for (const item of rungs.length > 0 ? items : []) {
    const base = { item: item.id, language: item.language };
    let videoId = item.url;
    try {
      const { ref } = sc.registry.resolve(item.url);
      videoId = ref.id;
      const reference = await creatorReference(sc, item, ref);
      if (!reference) {
        results.push({ ...base, videoId, rung: 'reference', outcome: 'skipped', reason: 'no-creator-captions' });
        continue;
      }
      const got = await audioFor(sc, ref);
      if ('error' in got) {
        for (const r of rungs) results.push({ ...base, videoId, rung: r.id, tier: r.tier, outcome: 'skipped', reason: 'no-audio', detail: got.error });
        continue;
      }
      const audioSec = got.audio.durationSec ?? item.durationSec;
      sc.ctx.log.info('eval stt item', { item: item.id, bytes: got.audio.data.byteLength, source: got.source });
      for (const rung of rungs) {
        clearCooldowns();
        const started = Date.now();
        try {
          const res = await transcribeLong(
            sc.registry,
            ref,
            got.audio,
            { chain: { only: [rung.id], allowPaid: true }, stt: { language: item.language }, concurrency: 1 },
            sc.ctx,
          );
          const wallMs = Date.now() - started;
          const hyp = textOf(res.transcript.segments);
          const refText = textOf(reference.segments);
          const opts = { language: item.language };
          const latencyMs = res.attempts
            .filter((a) => a.stage === 'stt' && a.outcome === 'ok' && a.reason !== 'split' && a.id === rung.id)
            .reduce((s, a) => s + (a.ms ?? 0), 0);
          results.push({
            ...base,
            videoId,
            rung: rung.id,
            tier: rung.tier,
            outcome: 'ok',
            wer: wordErrorRate(refText, hyp, opts),
            cer: characterErrorRate(refText, hyp, opts),
            timing: timingError(reference.segments, res.transcript.segments, opts),
            latencyMs,
            wallMs,
            audioSec,
            costUsd: costOf(rung.id, rung.tier, { audioSec }),
            attempts: res.attempts,
          });
        } catch (err) {
          results.push({
            ...base,
            videoId,
            rung: rung.id,
            tier: rung.tier,
            outcome: 'error',
            ...errorInfo(err),
            wallMs: Date.now() - started,
            audioSec,
            attempts: attemptsOf(err),
          });
        }
      }
    } catch (err) {
      results.push({ ...base, videoId, rung: 'reference', outcome: 'error', ...errorInfo(err), attempts: attemptsOf(err) });
    }
  }
  if (results.some((r) => r.reason === 'no-audio')) {
    notes.push('Some items had no audio: install a source that can download audio (the yt-dlp provider) to score them.');
  }
  const evaluated = new Set(results.filter((r) => r.outcome === 'ok').map((r) => r.item)).size;
  return {
    dataset: { file: `packages/evals/datasets/${file}`, items: items.length, evaluated },
    skippedRungs: skipped,
    notes,
    items: results,
    rungs: rungs.map((r) => r.id),
  };
}
