/**
 * Rules every chapter list must meet, whoever proposed it (the offline
 * segmenter, an LLM, a caller):
 *
 *   - the first chapter starts at 0
 *   - starts are strictly ascending and inside the video
 *   - every chapter, the last one included, lasts at least `minChapterSec` (default 60);
 *     a single chapter covering a shorter video is allowed
 *   - the count fits the duration: roughly one chapter per 3 to 8 minutes
 *   - every title is a non-empty line
 *
 * `finalizeChapters` fills `endSec` (the next start, the duration for the last).
 */
import type { Chapter } from '@vid2context/core';

export interface ChapterRules {
  /** Shortest allowed chapter in seconds. Default 60. */
  minChapterSec?: number;
  /** Shortest average chapter length used for the upper count bound. Default 180 (3 minutes). */
  minAverageSec?: number;
  /** Longest average chapter length used for the lower count bound. Default 480 (8 minutes). */
  maxAverageSec?: number;
}

export const DEFAULT_RULES: Required<ChapterRules> = { minChapterSec: 60, minAverageSec: 180, maxAverageSec: 480 };

export function resolveRules(rules: ChapterRules = {}): Required<ChapterRules> {
  return {
    minChapterSec: rules.minChapterSec ?? DEFAULT_RULES.minChapterSec,
    minAverageSec: rules.minAverageSec ?? DEFAULT_RULES.minAverageSec,
    maxAverageSec: rules.maxAverageSec ?? DEFAULT_RULES.maxAverageSec,
  };
}

/** Allowed chapter count for a duration: [floor(d / maxAverage), ceil(d / minAverage)], at least 1, and never more than minimum-length chapters fit. */
export function countRange(durationSec: number, rules: ChapterRules = {}): { min: number; max: number } {
  const r = resolveRules(rules);
  const fit = Math.max(1, Math.floor(durationSec / r.minChapterSec));
  const max = Math.min(fit, Math.max(1, Math.ceil(durationSec / r.minAverageSec)));
  const min = Math.min(max, Math.max(1, Math.floor(durationSec / r.maxAverageSec)));
  return { min, max };
}

/** Every rule the list breaks, as plain sentences. Empty means valid. */
export function checkChapters(chapters: Chapter[], durationSec: number, rules: ChapterRules = {}): string[] {
  const r = resolveRules(rules);
  const problems: string[] = [];
  if (chapters.length === 0) return ['There are no chapters.'];
  if (chapters[0]?.startSec !== 0) problems.push(`The first chapter starts at ${chapters[0]?.startSec}, not 0.`);
  const { min, max } = countRange(durationSec, r);
  if (chapters.length < min || chapters.length > max) {
    problems.push(`${chapters.length} chapters for ${Math.round(durationSec)} s; expected ${min} to ${max}.`);
  }
  chapters.forEach((c, i) => {
    if (typeof c.title !== 'string' || !c.title.trim() || /[\r\n]/.test(c.title)) {
      problems.push(`Chapter ${i + 1} has no usable title.`);
    }
    if (!Number.isFinite(c.startSec) || c.startSec < 0 || c.startSec >= durationSec) {
      problems.push(`Chapter ${i + 1} starts at ${c.startSec}, outside the video.`);
      return;
    }
    const next = chapters[i + 1]?.startSec ?? durationSec;
    if (next <= c.startSec) problems.push(`Chapter ${i + 2} does not start after chapter ${i + 1}.`);
    else if (chapters.length > 1 && next - c.startSec < r.minChapterSec) {
      problems.push(`Chapter ${i + 1} lasts ${Math.round(next - c.startSec)} s, under the ${r.minChapterSec} s minimum.`);
    }
  });
  return problems;
}

/** Copy the list with `endSec` filled: each chapter ends where the next starts, the last at the duration. */
export function finalizeChapters<C extends Chapter>(chapters: C[], durationSec: number): C[] {
  return chapters.map((c, i) => ({ ...c, endSec: chapters[i + 1]?.startSec ?? durationSec }));
}
