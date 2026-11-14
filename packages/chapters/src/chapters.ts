/**
 * autoChapters(): chapters for a video that has none. The offline TextTiling
 * segmenter proposes boundaries (no model, no network); when an LLM rung is
 * enabled, it titles them and may nudge each boundary within a small window.
 * Every result passes the chapter rules in validate.ts. When the LLM answer
 * is unusable, the offline boundaries are kept with titles built from each
 * chapter's most distinctive terms.
 */
import {
  type Attempt,
  type ChainOptions,
  type Chapter,
  type Ctx,
  type Registry,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import {
  askChapters,
  cleanSummary,
  cleanTitle,
  DEFAULT_WINDOW_SEC,
  promptBudget,
  type RawChapter,
  refineRequest,
  snapInWindow,
} from './llm.ts';
import { textTiling } from './texttiling.ts';
import { distinctiveTerms, titleFromTerms } from './titles.ts';
import { type ChapterRules, checkChapters, finalizeChapters } from './validate.ts';

/** Producer id of chapters made by the offline segmenter alone. */
export const OFFLINE_PRODUCER = 'chapters/texttiling';

export interface AutoChapter extends Chapter {
  endSec: number;
  /** One or two sentences, present when `summaries` was asked and the LLM answered. */
  summary?: string;
}

export interface AutoChaptersOptions extends ChapterRules {
  /** Title and refine with the LLM chain. Default true; false stays fully offline. */
  llm?: boolean;
  /** Ask the LLM for a one or two sentence summary per chapter. Default false. */
  summaries?: boolean;
  /** Run even when the video already has chapters. Default false. */
  force?: boolean;
  /** How far (seconds) the LLM may move a boundary. Default 45. */
  windowSec?: number;
  /** Preferred average chapter length in seconds. Default 300. */
  targetSec?: number;
  /** Rung chain options for the LLM step. JSON support is always required. */
  chain?: ChainOptions;
}

export interface AutoChaptersResult {
  chapters: AutoChapter[];
  /** The LLM rung that titled the chapters, or `chapters/texttiling` when they are fully offline. */
  producer: string;
  /** Set when an LLM rung answered and its answer was used. */
  rung?: string;
  model?: string;
  source: 'auto';
  /** `texttiling` (offline only) or `texttiling+llm`. */
  method: 'texttiling' | 'texttiling+llm';
  durationSec: number;
  /** Every LLM rung tried. */
  attempts: Attempt[];
  /** What happened along the way: fallbacks, moved or kept boundaries. */
  notes: string[];
}

function durationOf(context: VideoContext): number {
  const meta = context.metadata.durationSec;
  return meta && meta > 0 ? meta : (context.transcript.segments.at(-1)?.endSec ?? 0);
}

/** Turn the model's chapters into a checked list, or say why it cannot be used. */
function applyAnswer(
  raw: RawChapter[],
  starts: number[],
  context: VideoContext,
  durationSec: number,
  windowSec: number,
  summaries: boolean,
  rules: ChapterRules,
): { chapters: AutoChapter[]; notes: string[]; titlesOnly: boolean } | { error: string } {
  if (raw.length !== starts.length) return { error: `the model returned ${raw.length} chapters for ${starts.length} sections` };
  const titles = raw.map((r) => cleanTitle(r.title));
  if (titles.some((t) => !t)) return { error: 'a chapter title was missing or empty' };
  const notes: string[] = [];
  const segments = context.transcript.segments;
  const moved = starts.map((s, i) => {
    if (i === 0) return 0;
    const want = typeof raw[i]?.startSec === 'number' ? (raw[i]?.startSec as number) : Number(raw[i]?.startSec);
    if (!Number.isFinite(want) || want === s) return s;
    const lo = Math.max(0, s - windowSec);
    const hi = Math.min(durationSec, s + windowSec);
    if (want < lo || want > hi) {
      notes.push(
        `Kept the start of chapter ${i + 1} at ${Math.round(s)} s: the model moved it to ${want} s, outside its window.`,
      );
      return s;
    }
    return snapInWindow(segments, want, lo, hi) ?? s;
  });
  const build = (at: number[]): AutoChapter[] =>
    finalizeChapters(
      at.map((startSec, i) => {
        const summary = summaries ? cleanSummary(raw[i]?.summary) : '';
        return { title: titles[i] ?? '', startSec, endSec: 0, ...(summary ? { summary } : {}) };
      }),
      durationSec,
    );
  const refined = build(moved);
  const problems = checkChapters(refined, durationSec, rules);
  if (problems.length === 0) {
    const n = moved.filter((s, i) => s !== starts[i]).length;
    if (n > 0) notes.push(`The model moved ${n} boundar${n === 1 ? 'y' : 'ies'} within the ${windowSec} s window.`);
    return { chapters: refined, notes, titlesOnly: false };
  }
  notes.push(`Kept the offline boundaries: the moved ones broke a rule (${problems[0]}).`);
  return { chapters: build(starts), notes, titlesOnly: true };
}

/** Propose valid chapters for a video. Raw transcript and metadata are never changed. */
export async function autoChapters(
  registry: Registry,
  context: VideoContext,
  opts: AutoChaptersOptions,
  ctx: Ctx,
): Promise<AutoChaptersResult> {
  const existing = context.metadata.chapters?.length ?? 0;
  if (existing > 0 && !opts.force) {
    throw new Vid2ContextError('bad-request', `${context.metadata.ref.id} already has ${existing} chapters from the platform.`, {
      hint: 'Use the existing chapters (metadata.chapters), or pass force: true to propose new ones.',
    });
  }
  const segments = context.transcript.segments;
  if (segments.length === 0) {
    throw new Vid2ContextError('no-transcript', `The transcript of ${context.metadata.ref.id} is empty.`, {
      hint: 'Chapters are built from the transcript. Retry with mode "stt" to transcribe the audio.',
    });
  }
  const durationSec = durationOf(context);
  const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC;
  const tiling = textTiling(segments, {
    durationSec,
    language: context.transcript.language,
    targetSec: opts.targetSec,
    minChapterSec: opts.minChapterSec,
    minAverageSec: opts.minAverageSec,
    maxAverageSec: opts.maxAverageSec,
  });
  const terms = distinctiveTerms(tiling.terms, tiling.segs);
  const offline = finalizeChapters(
    tiling.starts.map((startSec, i) => ({ title: titleFromTerms(terms[i] ?? [], i), startSec, endSec: 0 }) as AutoChapter),
    durationSec,
  );
  const problems = checkChapters(offline, durationSec, opts);
  if (problems.length > 0) {
    // Only reachable with contradictory rules (for example a minimum length longer than the video allows).
    throw new Vid2ContextError('bad-request', `No chapter list fits the rules: ${problems.join(' ')}`, {
      hint: 'Lower minChapterSec or widen minAverageSec and maxAverageSec.',
    });
  }
  const base: AutoChaptersResult = {
    chapters: offline,
    producer: OFFLINE_PRODUCER,
    source: 'auto',
    method: 'texttiling',
    durationSec,
    attempts: [],
    notes: [],
  };
  if (opts.llm === false) return base;

  const chain = opts.chain ?? {};
  const summaries = opts.summaries ?? false;
  const req = refineRequest({
    context,
    starts: tiling.starts,
    durationSec,
    windowSec,
    summaries,
    budget: promptBudget(registry, chain, ctx),
  });
  const answer = await askChapters(registry, req, chain, ctx, base.attempts);
  if (!answer) {
    base.notes.push('No LLM rung gave a usable answer, so titles come from the most distinctive terms of each chapter.');
    return base;
  }
  const applied = applyAnswer(answer.raw, tiling.starts, context, durationSec, windowSec, summaries, opts);
  if ('error' in applied) {
    base.attempts.push({ id: answer.rung, stage: 'llm', outcome: 'error', reason: 'invalid-chapters', detail: applied.error });
    base.notes.push(
      `The LLM answer was not usable (${applied.error}), so titles come from the most distinctive terms of each chapter.`,
    );
    return base;
  }
  return {
    ...base,
    chapters: applied.chapters,
    producer: answer.rung,
    rung: answer.rung,
    model: answer.model,
    method: 'texttiling+llm',
    notes: applied.notes,
  };
}

/**
 * A copy of the context with the auto chapters in its metadata and
 * `extra.chapterSource = 'auto'`, for callers that store it. The transcript is
 * shared, never changed.
 */
export function withAutoChapters(context: VideoContext, result: AutoChaptersResult): VideoContext {
  return {
    ...context,
    metadata: {
      ...context.metadata,
      chapters: result.chapters.map(({ title, startSec, endSec }) => ({ title, startSec, endSec })),
      extra: { ...(context.metadata.extra ?? {}), chapterSource: 'auto', chapterProducer: result.producer },
    },
  };
}
