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
/** "Intro - 0:00", "Intro | 0:00", "Intro (0:00)", "Intro [0:00]". A separator or brackets are required. */
const TRAILING = new RegExp(`^\\s*${BULLET}(\\S.*?)\\s*(?:${SEP}\\s*(${TS})|${BRACKETED})\\s*$`, 'u');

/** Seconds from "h:mm:ss", "mm:ss" or "m:ss". */
export function parseClock(s: string): number {
  return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

const cleanTitle = (t: string): string =>
  t
    .replace(/^[\s\-:|.~–—]+/u, '')
    .replace(/[\s\-:|~–—]+$/u, '')
    .trim();

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
 * at a line stamped 0:00, continues while timestamps ascend, has at least
 * three entries, and every chapter but the last runs at least 10 seconds.
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
  if (!validList(list)) return [];
  return withEnds(list, durationSec);
}

const MIN_CHAPTER_SEC = 10;

function validList(list: { startSec: number }[]): boolean {
  if (list.length < 3 || list[0]?.startSec !== 0) return false;
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const cur = list[i];
    if (!prev || !cur || cur.startSec - prev.startSec < MIN_CHAPTER_SEC) return false;
  }
  return true;
}
