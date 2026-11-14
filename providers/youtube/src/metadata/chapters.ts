/**
 * Chapters from the three places YouTube exposes them: the creator's
 * timestamps in the description, the player bar's chapter markers in the
 * `next` response, and auto-generated key moments. See
 * docs/guides/youtube.md, "Metadata and chapters", for the precedence.
 */
import type { Chapter } from '@vid2context/core';

export type ChapterSource = 'description' | 'markers' | 'key-moments';

/** h:mm:ss, mm:ss or m:ss. Hours need two-digit minutes. */
const TS = '(?:\\d{1,2}:[0-5]\\d|[0-5]?\\d):[0-5]\\d';
/** Separators allowed between a timestamp and its title. */
const SEP = '[-:|.~\\u2013\\u2014\\u2022\\u25B6\\u27A4>]+';
/** List markers before a leading timestamp: bullets, arrows, "1." or "1)". */
const BULLET = '(?:[-*\\u2022\\u25B6\\u25BA\\u27A4>]+\\s*|\\d{1,3}[.)]\\s+)?';
const BRACKETED = `[[(]\\s*(${TS})(?:\\s*[-\\u2013\\u2014~]\\s*${TS})?\\s*[\\])]`;
const BARE = `(${TS})(?:\\s*[-\\u2013\\u2014~]\\s*${TS})?`;

/** "0:00 Intro", "- 00:05 - The cool thing", "(1:02:03) Outro", "[12:00] Q&A", "0:00 - 1:30 Setup". */
const LEADING = new RegExp(`^\\s*${BULLET}(?:${BRACKETED}|${BARE})(?:\\s*${SEP}\\s*|\\s+)(\\S.*?)\\s*$`, 'u');
/** "Intro - 0:00", "Intro | 0:00", "Intro (0:00)", "Song by Artist 5:20". A list number stays part of the title, as on YouTube. */
const TRAILING = new RegExp(`^\\s*(\\S.*?)\\s*(?:(?:${SEP}\\s*|\\s)(${TS})|${BRACKETED})\\s*$`, 'u');
/** A bare trailing timestamp after one of these words is a reference in a sentence ("skip to 3:45"), not a chapter. */
const REFERENCE = /(?:^|\s)(?:at|from|to|till|until|around|after|before|since|about|starts?|starting|@)$/iu;

/** Seconds from "h:mm:ss", "mm:ss" or "m:ss". */
export function parseClock(s: string): number {
  return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** Emoji, variation selectors and joiners that YouTube strips from the ends of chapter titles. */
const EDGE_SYMBOLS = '[\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}\\u{FE0F}\\u{200D}\\u{20E3}]';
const LEADING_JUNK = new RegExp(`^(?:[\\s\\-:|.~\\u2013\\u2014]|${EDGE_SYMBOLS})+`, 'u');
const TRAILING_JUNK = new RegExp(`(?:[\\s\\-:|~\\u2013\\u2014]|${EDGE_SYMBOLS})+$`, 'u');
const QUOTED = /^(["\u201C\u2018'])(.+)(["\u201D\u2019'])$/u;

/** Trim separators and edge emoji, collapse spaces, and drop quotes that wrap the whole title (as YouTube does). */
export function cleanTitle(raw: string): string {
  const t = raw.replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '').replace(/\s+/gu, ' ').trim();
  const q = QUOTED.exec(t);
  return q?.[2] ? q[2].trim() : t;
}

/** One timestamped line, or null. Timestamps in the middle of a sentence never match. */
export function parseChapterLine(line: string): { title: string; startSec: number } | null {
  const lead = LEADING.exec(line);
  if (lead) {
    const clock = lead[1] ?? lead[2];
    const title = cleanTitle(lead[3] ?? '');
    if (clock && title) return { title, startSec: parseClock(clock) };
  }
  const trail = TRAILING.exec(line);
  if (trail) {
    const clock = trail[2] ?? trail[3];
    const bare =
      trail[2] !== undefined && !/[-:|.~\u2013\u2014\u2022\u25B6\u27A4>]\s*$/u.test(line.slice(0, line.lastIndexOf(trail[2])));
    if (bare && REFERENCE.test(trail[1] ?? '')) return null;
    const title = cleanTitle(trail[1] ?? '');
    if (clock && title) return { title, startSec: parseClock(clock) };
  }
  return null;
}

/** Give every chapter an endSec: the next chapter's start, and the video's duration for the last. */
export function withEnds(chapters: { title: string; startSec: number }[], durationSec?: number): Chapter[] {
  return chapters.map((c, i) => {
    const endSec = chapters[i + 1]?.startSec ?? (durationSec && durationSec > c.startSec ? durationSec : undefined);
    return endSec === undefined ? { title: c.title, startSec: c.startSec } : { title: c.title, startSec: c.startSec, endSec };
  });
}

/**
 * Chapters the way YouTube derives them from a description: the list starts
 * at a line stamped 0:00, continues while timestamps ascend (and stay inside
 * the video), and has at least three entries. YouTube's help page also asks
 * for 10-second chapters, but YouTube itself accepts shorter ones (the 5 s
 * "Intro" of jNQXAC9IVRw, the 6 s intro of WHRTbEgRYps), so this parser
 * does not enforce it either.
 * Lines before the 0:00 line and after the list ends are ignored, so stray
 * timestamps elsewhere in the description do not leak in. Returns [] when
 * the description does not qualify.
 */
export function parseDescriptionChapters(description: string | undefined, durationSec?: number): Chapter[] {
  if (!description) return [];
  const list: { title: string; startSec: number }[] = [];
  for (const line of description.split(/\r?\n/)) {
    const entry = parseChapterLine(line);
    if (!entry) continue;
    if (list.length === 0) {
      if (entry.startSec === 0) list.push(entry);
      continue;
    }
    const prev = list[list.length - 1];
    if (!prev || entry.startSec <= prev.startSec) break;
    if (durationSec && entry.startSec >= durationSec) break;
    list.push(entry);
  }
  if (list.length < 3) return [];
  return withEnds(list, durationSec);
}
