/**
 * Captions and cleanup suites: platform auto-captions, raw and cleaned,
 * against the creator captions of the same video.
 *
 *   captions  raw auto-captions: WER, CER, word timing, punctuation and
 *             capitalization F1
 *   cleanup   the same rows plus core's `cleanTranscript` applied to the
 *             auto-captions (rule-based steps only, no LLM), so the effect of
 *             cleanup on each metric is visible side by side. The raw track
 *             is never replaced: cleanup is scored as an added layer.
 *
 * Both tracks come from recorded references (datasets/refs/). The creator
 * track can also be fetched live through the pipeline; the auto track
 * cannot, because no captions provider lets a caller ask for the auto track
 * when a creator track exists (see docs/evals.md).
 */
import type { Segment } from '@vid2context/core';
import { datasetLabel, datasetPath, loadVideoDataset, type VideoItem } from '../dataset.ts';
import { punctuationF1 } from '../metrics/punctuation.ts';
import { timingError } from '../metrics/timing.ts';
import { characterErrorRate, wordErrorRate } from '../metrics/wer.ts';
import { textOf } from '../refs.ts';
import type { ItemResult } from '../results.ts';
import { autoReference, creatorReference, limited, referenceFailure, type SuiteContext } from './common.ts';
import type { SuiteOutput } from './stt.ts';

export const RAW_PRODUCER = 'youtube-auto-captions';

/** Score one hypothesis against a reference with every caption metric. */
export function scoreCaptions(
  item: Pick<VideoItem, 'id' | 'language'>,
  videoId: string,
  producer: string,
  reference: readonly Segment[],
  hypothesis: readonly Segment[],
): ItemResult {
  const opts = { language: item.language };
  const refText = textOf(reference);
  const hypText = textOf(hypothesis);
  return {
    item: item.id,
    videoId,
    language: item.language,
    rung: producer,
    outcome: 'ok',
    wer: wordErrorRate(refText, hypText, opts),
    cer: characterErrorRate(refText, hypText, opts),
    timing: timingError(reference, hypothesis, opts),
    punctuation: punctuationF1(refText, hypText),
  };
}

export async function runCaptionsSuite(sc: SuiteContext): Promise<SuiteOutput> {
  const path = datasetPath(sc.dataset ?? 'captions.json');
  const dataset = loadVideoDataset(path);
  const items = limited(dataset.items, sc.limit);
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
        results.push({ item: item.id, videoId, language: item.language, rung: RAW_PRODUCER, outcome: 'skipped', reason });
        continue;
      }
      results.push(scoreCaptions(item, videoId, RAW_PRODUCER, creator.segments, auto.segments));
    } catch (err) {
      results.push({
        item: item.id,
        videoId,
        language: item.language,
        rung: RAW_PRODUCER,
        outcome: 'error',
        ...referenceFailure(err),
      });
    }
  }
  if (results.some((r) => r.reason === 'no-auto-captions')) {
    notes.push('Items whose video has no auto-caption track in the item language were skipped.');
  }
  const evaluated = new Set(results.filter((r) => r.outcome === 'ok').map((r) => r.item)).size;
  return {
    dataset: { file: datasetLabel(path), items: items.length, evaluated },
    skippedRungs: [],
    notes,
    items: results,
    rungs: [RAW_PRODUCER],
  };
}
