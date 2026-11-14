/**
 * SRT and WebVTT parsing into transcript segments. Tolerant of what real
 * files contain: a UTF-8 BOM, CRLF or CR line endings, missing cue numbers,
 * cue settings after the timing ("align:start position:10%"), multi-line
 * cues, MM:SS timings, comma or dot milliseconds, NOTE/STYLE/REGION blocks,
 * HTML-style tags, ASS override codes and voice tags (kept as the speaker).
 * Pure functions; no Node APIs.
 */
import type { Segment } from '@vid2context/core';

const TIMING =
  /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)(?:\s+.*)?$/;

/** Seconds from '01:02:03,456', '02:03.4' or '1:02:03'. */
export function parseTimestamp(text: string): number {
  const [clock = '', frac = ''] = text.trim().split(/[.,]/);
  const parts = clock.split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec + (frac ? Number(frac.padEnd(3, '0').slice(0, 3)) / 1000 : 0);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

function cleanText(lines: string[]): { text: string; speaker?: string } {
  let speaker: string | undefined;
  const joined = lines
    .map((l) => {
      const voice = /<v(?:\.[^\s>]+)?\s+([^>]+)>/.exec(l);
      if (voice?.[1] && !speaker) speaker = voice[1].trim();
      return l
        .replace(/\{\\[^}]*\}/g, '') // ASS override codes: {\an8}, {\i1}
        .replace(/<[^>]*>/g, '') // tags: <i>, <c.yellow>, <v Name>, <00:00:01.000>
        .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
          if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
          if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)));
          return ENTITIES[e.toLowerCase()] ?? m;
        })
        .replace(/\\N/g, ' ')
        .trim();
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text: joined, speaker };
}

/** Parse SRT or WebVTT text (detected from content) into segments sorted by start time. */
export function parseSubtitles(input: string): Segment[] {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n[ \t]*\n/);
  const out: Segment[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const first = lines.findIndex((l) => l.trim() !== '');
    if (first < 0) continue;
    const head = lines[first]?.trim() ?? '';
    if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(head)) {
      // A WEBVTT header can be followed directly by a cue in sloppy files; only skip when no timing line follows.
      if (!lines.slice(first + 1).some((l) => TIMING.test(l))) continue;
    }
    const timingAt = lines.findIndex((l) => TIMING.test(l));
    if (timingAt < 0) continue;
    const m = TIMING.exec(lines[timingAt] ?? '');
    if (!m?.[1] || !m[2]) continue;
    const startSec = parseTimestamp(m[1]);
    const endSec = parseTimestamp(m[2]);
    const { text: cueText, speaker } = cleanText(lines.slice(timingAt + 1));
    if (!cueText) continue;
    const seg: Segment = { startSec, endSec: Math.max(endSec, startSec), text: cueText };
    if (speaker) seg.speaker = speaker;
    out.push(seg);
  }
  return out.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}
