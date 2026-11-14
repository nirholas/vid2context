/**
 * cleanTranscript: the cleanup steps in one fixed order. Returns a new
 * transcript (same ref, origin and producer) and a combined report; the input
 * is never changed, so the raw transcript stays available.
 *
 *   1. normalizeCaptionText   always
 *   2. dedupeRollingCaptions  auto-captions only
 *   3. guardRepetition        stt and video-model only
 *   4. restoreSentences       unless opts.sentences is false (skips itself on punctuated text)
 *   5. removeFillers          only with opts.fillers
 *   6. punctuateWithLlm       only with opts.llm (the only step that can use the network)
 */
import type { Registry } from '../registry.ts';
import type { Ctx, Transcript } from '../types.ts';
import { removeFillers } from './fillers.ts';
import { type PunctuateWithLlmOptions, punctuateWithLlm } from './llm.ts';
import { type NormalizeCaptionOptions, normalizeCaptionText } from './normalize.ts';
import { type GuardRepetitionOptions, guardRepetition } from './repetition.ts';
import { type CleanReport, mergeCleanReports } from './report.ts';
import { dedupeRollingCaptions } from './rolling.ts';
import { restoreSentences } from './sentences.ts';

export interface CleanTranscriptOptions extends NormalizeCaptionOptions {
  /** Rule-based sentences for unpunctuated text. Default true. */
  sentences?: boolean;
  /** Remove um/uh/erm fillers. Default false. */
  fillers?: boolean;
  repetition?: GuardRepetitionOptions;
  /** Run the LLM punctuation pass through this registry's LLM rungs. */
  llm?: PunctuateWithLlmOptions & { registry: Registry; ctx: Ctx };
}

export async function cleanTranscript(
  transcript: Transcript,
  opts: CleanTranscriptOptions = {},
): Promise<{ transcript: Transcript; report: CleanReport }> {
  const reports: CleanReport[] = [];
  const run = (step: { segments: Transcript['segments']; report: CleanReport }) => {
    reports.push(step.report);
    return step.segments;
  };
  let segments = run(normalizeCaptionText(transcript.segments, opts));
  if (transcript.origin === 'auto-captions') segments = run(dedupeRollingCaptions(segments));
  if (transcript.origin === 'stt' || transcript.origin === 'video-model')
    segments = run(guardRepetition(segments, opts.repetition));
  if (opts.sentences ?? true) segments = run(restoreSentences(segments));
  if (opts.fillers) segments = run(removeFillers(segments));
  let out: Transcript = { ...transcript, segments };
  if (opts.llm) {
    const { registry, ctx, ...llmOpts } = opts.llm;
    const res = await punctuateWithLlm(out, registry, ctx, llmOpts);
    reports.push(res.report);
    out = res.transcript;
  }
  return { transcript: out, report: mergeCleanReports(...reports) };
}
