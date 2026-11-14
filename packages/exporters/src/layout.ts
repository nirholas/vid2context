/**
 * Shared note layout for every exporter: the transcript cut into sections (one
 * per chapter, or a single "Transcript" section when the video has none) and
 * each section into readable paragraphs that start at a citable timestamp.
 * The segments themselves are never changed: paragraphs only join their text.
 */
import { type Chapter, formatTimestamp, type Segment, timestampUrl, type VideoContext } from '@vid2context/core';

export interface Paragraph {
  startSec: number;
  endSec: number;
  /** "m:ss", or "h:mm:ss" when the video is an hour or longer. */
  stamp: string;
  /** Deep link that opens the video at `startSec`, when the platform has one. */
  url?: string;
  text: string;
}

export interface Section {
  /** The chapter title, or "Transcript" when the video has no chapters. */
  title: string;
  chapter?: Chapter;
  startSec: number;
  stamp: string;
  url?: string;
  paragraphs: Paragraph[];
}

export interface LayoutOptions {
  /** A paragraph closes at the first sentence end after this many seconds. Default 30. */
  softSec?: number;
  /** A paragraph always closes after this many seconds, for captions without punctuation. Default 45. */
  hardSec?: number;
  /** A paragraph also closes once its text reaches this many characters. Default 1200. */
  maxChars?: number;
}

const SENTENCE_END = /[.!?。！？]["')\]]*$/;

/** True when timestamps need an hour field, so every stamp in one note has the same shape. */
export function isLong(context: VideoContext): boolean {
  return (context.metadata.durationSec ?? context.transcript.segments.at(-1)?.endSec ?? 0) >= 3600;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function paragraphsOf(segments: Segment[], context: VideoContext, opts: Required<LayoutOptions>): Paragraph[] {
  const long = isLong(context);
  const ref = context.metadata.ref;
  const out: Paragraph[] = [];
  let open: { startSec: number; endSec: number; parts: string[]; chars: number } | undefined;
  const close = () => {
    if (!open) return;
    const text = clean(open.parts.join(' '));
    if (text) {
      out.push({
        startSec: open.startSec,
        endSec: open.endSec,
        stamp: formatTimestamp(open.startSec, long),
        url: timestampUrl(ref, open.startSec),
        text,
      });
    }
    open = undefined;
  };
  for (const seg of segments) {
    const text = clean(seg.text);
    if (!text) continue;
    if (!open) open = { startSec: seg.startSec, endSec: seg.endSec, parts: [], chars: 0 };
    open.parts.push(text);
    open.chars += text.length + 1;
    open.endSec = Math.max(open.endSec, seg.endSec);
    const age = seg.endSec - open.startSec;
    if ((age >= opts.softSec && SENTENCE_END.test(text)) || age >= opts.hardSec || open.chars >= opts.maxChars) close();
  }
  close();
  return out;
}

/** Sections in time order. A segment belongs to the last chapter that starts at or before it (the first chapter for earlier ones). */
export function layoutTranscript(context: VideoContext, options: LayoutOptions = {}): Section[] {
  const opts: Required<LayoutOptions> = { softSec: 30, hardSec: 45, maxChars: 1200, ...options };
  const long = isLong(context);
  const ref = context.metadata.ref;
  const segments = [...context.transcript.segments].sort((a, b) => a.startSec - b.startSec);
  const chapters = [...context.metadata.chapters].sort((a, b) => a.startSec - b.startSec);
  if (chapters.length === 0) {
    const startSec = segments[0]?.startSec ?? 0;
    return [
      {
        title: 'Transcript',
        startSec,
        stamp: formatTimestamp(startSec, long),
        url: timestampUrl(ref, startSec),
        paragraphs: paragraphsOf(segments, context, opts),
      },
    ];
  }
  const buckets: Segment[][] = chapters.map(() => []);
  for (const seg of segments) {
    let index = 0;
    for (let i = 0; i < chapters.length; i++) if ((chapters[i]?.startSec ?? 0) <= seg.startSec) index = i;
    buckets[index]?.push(seg);
  }
  return chapters.map((chapter, i) => ({
    title: clean(chapter.title) || `Chapter ${i + 1}`,
    chapter,
    startSec: chapter.startSec,
    stamp: formatTimestamp(chapter.startSec, long),
    url: timestampUrl(ref, chapter.startSec),
    paragraphs: paragraphsOf(buckets[i] ?? [], context, opts),
  }));
}
