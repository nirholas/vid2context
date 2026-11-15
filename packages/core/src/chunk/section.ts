/**
 * Sections: one time range or chapter of a video as a full VideoContext, so
 * every formatter renders it unchanged.
 */
import { Vid2ContextError } from '../errors.ts';
import { formatTimestamp } from '../segments.ts';
import type { VideoContext } from '../types.ts';
import { item, mediaEnd, type Span, sectionSpans } from './spans.ts';

export interface SectionSelector {
  /** Start of the range in seconds. Default: the start of the video. */
  fromSec?: number;
  /** End of the range in seconds (exclusive). Default: the end of the video. */
  toSec?: number;
  /** An outline section index, or a chapter title (exact, then prefix, then substring, case-insensitive). */
  chapter?: number | string;
}

/** What `getSection` stores in `metadata.extra.section`. */
export interface SectionInfo {
  fromSec: number;
  toSec: number;
  chapterTitle?: string;
}

const TIME_HINT = 'Use seconds (754), m:ss (12:34) or h:mm:ss (1:02:03).';

/** Parse a `from` or `to` argument: seconds (`754`, `75.5`), `m:ss` or `h:mm:ss`. Throws `bad-request` otherwise. */
export function parseTimeArg(value: string | number): number {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) return value;
  } else {
    const v = value.trim();
    if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
    const m = /^(?:(\d+):([0-5]\d)|(\d+)):([0-5]\d(?:\.\d+)?)$/.exec(v);
    if (m) {
      const [, h, mm, mOnly, ss] = m;
      return h !== undefined ? Number(h) * 3600 + Number(mm) * 60 + Number(ss) : Number(mOnly) * 60 + Number(ss);
    }
  }
  throw new Vid2ContextError('bad-request', `Invalid time "${value}".`, { hint: TIME_HINT });
}

function findSection(spans: Span[], chapter: number | string): Span {
  const list = spans.map((s) => `${s.index}: ${s.title}`).join('; ');
  const hint = spans.length > 0 ? `Sections: ${list}.` : 'This video has no transcript sections.';
  if (typeof chapter === 'number') {
    const span = Number.isInteger(chapter) ? spans[chapter] : undefined;
    if (span) return span;
    throw new Vid2ContextError('bad-request', `No section with index ${chapter}.`, { hint });
  }
  const q = chapter.trim().toLowerCase();
  const titles = spans.map((s) => s.title.toLowerCase());
  const i = [titles.indexOf(q), titles.findIndex((t) => t.startsWith(q)), titles.findIndex((t) => t.includes(q))].find(
    (n) => n >= 0,
  );
  if (q && i !== undefined) return item(spans, i);
  throw new Vid2ContextError('bad-request', `No chapter matches "${chapter}".`, { hint });
}

/**
 * One section of a video as a VideoContext. A time range keeps every segment
 * that overlaps it; a chapter keeps the segments that start inside it (the
 * same ones its outline token count covers). `metadata.chapters` is trimmed
 * to the range and `metadata.extra.section` records `{ fromSec, toSec, chapterTitle? }`.
 * The raw transcript is not changed, only sliced.
 */
export function getSection(context: VideoContext, sel: SectionSelector): VideoContext {
  const segs = context.transcript.segments;
  const end = mediaEnd(context);
  let fromSec = sel.fromSec ?? 0;
  let toSec = sel.toSec ?? end;
  let chapterTitle: string | undefined;
  let kept = segs.filter((s) => s.endSec > fromSec && s.startSec < toSec);

  if (sel.chapter !== undefined) {
    const span = findSection(sectionSpans(context), sel.chapter);
    chapterTitle = span.title;
    fromSec = Math.max(span.startSec, sel.fromSec ?? span.startSec);
    toSec = Math.min(span.endSec, sel.toSec ?? span.endSec);
    kept = segs.slice(span.first, span.last + 1).filter((s) => s.endSec > fromSec && s.startSec < toSec);
  }
  if (!(fromSec < toSec)) {
    throw new Vid2ContextError('bad-request', `Empty range: from ${formatTimestamp(fromSec)} to ${formatTimestamp(toSec)}.`, {
      hint: `The start must be before the end, and the video runs from 0:00 to ${formatTimestamp(end)}.`,
    });
  }
  if (end > 0 && fromSec >= end) {
    throw new Vid2ContextError('bad-request', `The video ends at ${formatTimestamp(end)}, before ${formatTimestamp(fromSec)}.`, {
      hint: `Pick a start between 0:00 and ${formatTimestamp(end)}.`,
    });
  }

  const chapters = context.metadata.chapters
    .map((c, i, all) => ({ c, endSec: c.endSec ?? all[i + 1]?.startSec ?? end }))
    .filter(({ c, endSec }) => endSec > fromSec && c.startSec < toSec)
    .map(({ c, endSec }) => ({ ...c, startSec: Math.max(c.startSec, fromSec), endSec: Math.min(endSec, toSec) }));
  const section: SectionInfo = { fromSec, toSec, ...(chapterTitle !== undefined ? { chapterTitle } : {}) };

  return {
    ...context,
    metadata: { ...context.metadata, chapters, extra: { ...context.metadata.extra, section } },
    transcript: { ...context.transcript, segments: kept },
  };
}
