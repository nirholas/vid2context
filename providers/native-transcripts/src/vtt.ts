/**
 * WebVTT to segments. Handles what real platform tracks contain: a BOM, CRLF
 * or CR line ends, a header line with text after "WEBVTT", header metadata,
 * NOTE, STYLE and REGION blocks, cue identifiers, short (mm:ss.ttt) and long
 * (hh:mm:ss.ttt) timestamps, cue settings after the end time, multi-line cue
 * text, inline tags (<i>, <c.class>, <00:00:01.000> karaoke stamps) and voice
 * spans (<v Name>), which become the segment speaker.
 *
 * Rolling captions (each cue repeats the previous cue's last line, then adds
 * one) are collapsed so every line of speech appears once, and back-to-back
 * cues with the same text are merged.
 */
import { decodeEntities, type Segment } from '@vid2context/core';

const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(?:\s+.*)?$/;

/** "01:02:03.500" or "02:03.500" to seconds. */
export function vttTime(stamp: string): number {
  const parts = stamp.replace(',', '.').split(':');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  return Math.round(sec * 1000) / 1000;
}

interface Cue {
  start: number;
  end: number;
  lines: string[];
  speaker?: string;
}

/** Strip tags from one cue line, returning the text and the first voice name seen. */
function cleanLine(line: string): { text: string; speaker?: string } {
  let speaker: string | undefined;
  const text = line.replace(
    /<\/?([a-z0-9]+)?(?:\.[^\s>]*)?(?:\s+([^>]*))?>|<\d[^>]*>/gi,
    (_m, tag?: string, annotation?: string) => {
      if (tag?.toLowerCase() === 'v' && annotation && speaker === undefined) speaker = annotation.trim();
      return '';
    },
  );
  return { text: decodeEntities(text).replace(/\s+/g, ' ').trim(), speaker };
}

function parseCues(raw: string): Cue[] {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n[ \t]*\n+/);
  const cues: Cue[] = [];
  for (const [i, block] of blocks.entries()) {
    const lines = block.split('\n');
    if (i === 0 && /^WEBVTT(?:[ \t].*)?$/.test(lines[0]?.trim() ?? '')) {
      // The header block may itself hold a cue only in malformed files; header metadata never has "-->".
      const timingAt = lines.findIndex((l) => TIMING.test(l));
      if (timingAt < 0) continue;
      lines.splice(0, timingAt);
    }
    const first = lines[0]?.trim() ?? '';
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(first)) continue;
    const timingAt = lines.findIndex((l) => TIMING.test(l));
    if (timingAt < 0 || timingAt > 1) continue;
    const m = TIMING.exec(lines[timingAt] ?? '');
    if (!m?.[1] || !m[2]) continue;
    let speaker: string | undefined;
    const body: string[] = [];
    for (const line of lines.slice(timingAt + 1)) {
      const c = cleanLine(line);
      if (c.speaker !== undefined && speaker === undefined) speaker = c.speaker;
      if (c.text) body.push(c.text);
    }
    if (body.length === 0) continue;
    const start = vttTime(m[1]);
    const end = Math.max(start, vttTime(m[2]));
    cues.push({ start, end, lines: body, ...(speaker ? { speaker } : {}) });
  }
  return cues;
}

/** Drop leading lines of `cue` that repeat the trailing lines of `prev` (rolling captions). */
function dropRepeatedLines(prev: Cue, cue: Cue): string[] {
  const max = Math.min(prev.lines.length, cue.lines.length);
  for (let n = max; n > 0; n--) {
    const tail = prev.lines.slice(prev.lines.length - n);
    const head = cue.lines.slice(0, n);
    if (tail.every((l, i) => l === head[i])) return cue.lines.slice(n);
  }
  return cue.lines;
}

/** Parse a WebVTT document into ordered segments. Returns [] for an empty or cue-less file. */
export function parseVtt(raw: string): Segment[] {
  const out: Segment[] = [];
  let prev: Cue | undefined;
  for (const cue of parseCues(raw)) {
    const lines = prev ? dropRepeatedLines(prev, cue) : cue.lines;
    const last = out[out.length - 1];
    if (lines.length === 0) {
      // Pure repeat of the previous cue: extend it instead of adding a duplicate.
      if (last && cue.end > last.endSec) last.endSec = cue.end;
    } else {
      const textOut = lines.join(' ');
      if (last && last.text === textOut && cue.start <= last.endSec + 0.05) {
        last.endSec = Math.max(last.endSec, cue.end);
      } else {
        out.push({ startSec: cue.start, endSec: cue.end, text: textOut, ...(cue.speaker ? { speaker: cue.speaker } : {}) });
      }
    }
    prev = cue;
  }
  return out;
}
