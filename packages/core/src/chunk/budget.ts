/**
 * Budget planning: which videos, and which leading sections of the rest, fit
 * in a token budget, and exactly what was left out so the reader can be told.
 */
import type { VideoContext } from '../types.ts';
import { assertBudget, item, mediaEnd, rangeTokens, sectionSpans, segmentTokens, splitByTokens } from './spans.ts';

export interface BudgetOptions {
  /** Tokens to reserve per included video for its header (title, link, chapter list). Default 0. */
  perVideoOverhead?: number;
}

export interface BudgetRange {
  startSec: number;
  endSec: number;
  tokens: number;
}

export interface BudgetItem {
  videoId: string;
  /** True when the whole transcript fits. */
  whole: boolean;
  /** For partial videos: the leading ranges included, in order and contiguous from the start. Empty when nothing fit. */
  sections?: BudgetRange[];
}

export interface BudgetPlan {
  /** One item per input context, in input order. */
  items: BudgetItem[];
  /** Tokens used, overhead included. Never above the budget. */
  totalTokens: number;
  /** Everything left out, one range per partial or omitted video, so callers can say what is missing. */
  omitted: (BudgetRange & { videoId: string })[];
}

/** A contiguous piece of one video that can be included or left out as a whole. */
interface Unit extends BudgetRange {
  first: number;
  last: number;
  /** Outline section this unit belongs to; pieces of one section are reported merged. */
  of: number;
}

interface Video {
  id: string;
  context: VideoContext;
  total: number;
  end: number;
  sections: Unit[];
  taken: BudgetRange[];
  /** Outline section of the last taken range. */
  takenOf: number;
}

/** Split an outline section into pieces of at most `max` tokens, contiguous in time. */
function splitUnit(context: VideoContext, unit: Unit, max: number): Unit[] {
  const segs = context.transcript.segments;
  const ranges = splitByTokens(segs, unit.first, unit.last, Math.max(1, max), segmentTokens(segs));
  return ranges.map(([first, last], i) => ({
    of: unit.of,
    first,
    last,
    startSec: i === 0 ? unit.startSec : item(segs, first).startSec,
    endSec: i === ranges.length - 1 ? unit.endSec : item(segs, last + 1).startSec,
    tokens: rangeTokens(segs, first, last),
  }));
}

/** Take leading sections of `v` within `allowance` tokens, splitting the next section when it does not fit whole. */
function takeLeading(v: Video, allowance: number): number {
  let spent = 0;
  for (let next = v.sections[0]; next !== undefined; next = v.sections[0]) {
    if (next.tokens <= allowance - spent) {
      v.sections.shift();
      const prev = v.taken.at(-1);
      if (prev && v.takenOf === next.of) {
        prev.endSec = next.endSec;
        prev.tokens += next.tokens;
      } else v.taken.push({ startSec: next.startSec, endSec: next.endSec, tokens: next.tokens });
      v.takenOf = next.of;
      spent += next.tokens;
      continue;
    }
    const room = allowance - spent;
    if (room <= 0 || next.first > next.last) break;
    const pieces = splitUnit(v.context, next, room);
    const head = pieces[0];
    if (!head || head.tokens > room) break;
    v.sections.splice(0, 1, ...pieces);
  }
  return spent;
}

/**
 * Plan what fits in `maxTokens`. Whole videos are included in input order
 * while they fit (a video too large is skipped, not a stopper). The remaining
 * budget is shared across the other videos in proportion to their length,
 * each taking its leading sections first (a section that does not fit whole
 * is split on sentence ends or pauses); budget left over from rounding goes
 * to those videos again in input order. Everything not included is listed in
 * `omitted`. Token counts are `estimateTokens` estimates.
 */
export function fitToBudget(contexts: VideoContext[], maxTokens: number, opts: BudgetOptions = {}): BudgetPlan {
  assertBudget('maxTokens', maxTokens);
  const overhead = Math.max(0, opts.perVideoOverhead ?? 0);
  const videos: Video[] = contexts.map((context) => {
    const segs = context.transcript.segments;
    const sections = sectionSpans(context).map((s) => ({
      of: s.index,
      first: s.first,
      last: s.last,
      startSec: s.startSec,
      endSec: s.endSec,
      tokens: rangeTokens(segs, s.first, s.last),
    }));
    const end = mediaEnd(context);
    if (sections.length === 0) sections.push({ of: 0, first: 0, last: -1, startSec: 0, endSec: end, tokens: 0 });
    return {
      id: context.metadata.ref.id,
      context,
      total: sections.reduce((n, s) => n + s.tokens, 0),
      end,
      sections,
      taken: [],
      takenOf: -1,
    };
  });

  let remaining = maxTokens;
  const whole = new Set<Video>();
  for (const v of videos) {
    if (v.total + overhead <= remaining) {
      whole.add(v);
      remaining -= v.total + overhead;
    }
  }

  const rest = videos.filter((v) => !whole.has(v));
  // Reserve each partial video's header before sharing the rest by length.
  const partial: Video[] = [];
  for (const v of rest) {
    if (overhead >= remaining) break;
    remaining -= overhead;
    partial.push(v);
  }
  const restTotal = partial.reduce((n, v) => n + v.total, 0);
  const pool = remaining;
  for (const v of partial) remaining -= takeLeading(v, Math.floor((pool * v.total) / Math.max(1, restTotal)));
  for (const v of partial) remaining -= takeLeading(v, remaining);
  // A video whose header was reserved but got no transcript returns its header.
  for (const v of partial) if (v.taken.length === 0) remaining += overhead;

  const items: BudgetPlan['items'] = [];
  const omitted: BudgetPlan['omitted'] = [];
  for (const v of videos) {
    if (whole.has(v)) {
      items.push({ videoId: v.id, whole: true });
      continue;
    }
    items.push({ videoId: v.id, whole: false, sections: v.taken });
    const left = v.sections.reduce((n, s) => n + s.tokens, 0);
    const startSec = v.taken.at(-1)?.endSec ?? v.sections[0]?.startSec ?? 0;
    if (v.sections.length > 0)
      omitted.push({ videoId: v.id, startSec, endSec: v.sections.at(-1)?.endSec ?? v.end, tokens: left });
  }
  return { items, totalTokens: maxTokens - remaining, omitted };
}
