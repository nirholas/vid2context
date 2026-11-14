/**
 * WebVTT (and SRT) to transcript segments.
 *
 * Handles a BOM, CRLF, cue identifiers, cue settings after the timing line,
 * NOTE, STYLE and REGION blocks, inline tags (<c>, <i>, <b>, <u>, <ruby>,
 * <lang>, timestamp tags like <00:00:01.234>), <v Speaker> voice tags and
 * HTML entities. SRT's comma decimal separator is accepted too.
 *
 * Auto-generated tracks (YouTube's in particular) "roll": each cue repeats
 * the previous line and adds a new one, and tiny 10 ms cues re-show the text
 * between them. Collapsing is conservative: a cue's leading lines are dropped
 * only when they exactly equal the trailing lines of the cue just before it,
 * and a cue left with nothing new is dropped (or, when it follows straight on
 * from an identical cue, extends it).
 */
import type { Segment } from '@vid2context/core';

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(?:\s+.*)?$/;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
};

export function parseTimestamp(ts: string): number {
  const parts = ts.replace(',', '.').split(':');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  return Math.round(sec * 1000) / 1000;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Strip cue markup from one line; returns the text and a voice (speaker) if the line names one. */
function cleanLine(line: string): { text: string; speaker?: string } {
  const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(line)?.[1]?.trim();
  const text = decodeEntities(line.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return voice ? { text, speaker: voice } : { text };
}

interface RawCue {
  start: number;
  end: number;
  lines: string[];
  speaker?: string;
}

function parseCues(input: string): RawCue[] {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n[ \t]*\n/);
  const cues: RawCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingAt = lines.findIndex((l) => TIMING.test(l.trim()));
    if (timingAt < 0) continue; // WEBVTT header, NOTE, STYLE, REGION, or junk
    const first = lines[0]?.trim() ?? '';
    if (timingAt > 0 && /^(NOTE|STYLE|REGION)\b/.test(first)) continue;
    const m = TIMING.exec(lines[timingAt]?.trim() ?? '');
    if (!m?.[1] || !m[2]) continue;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    let speaker: string | undefined;
    const body: string[] = [];
    for (const raw of lines.slice(timingAt + 1)) {
      const cleaned = cleanLine(raw);
      speaker ??= cleaned.speaker;
      if (cleaned.text) body.push(cleaned.text);
    }
    cues.push({ start, end: Math.max(end, start), lines: body, ...(speaker ? { speaker } : {}) });
  }
  return cues;
}

/** Number of leading lines of `cur` that equal the trailing lines of `prev` (the largest such overlap). */
function overlap(prev: string[], cur: string[]): number {
  for (let k = Math.min(prev.length, cur.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== cur[i]) {
        same = false;
        break;
      }
    }
    if (same) return k;
  }
  return 0;
}

export function parseVtt(input: string): Segment[] {
  const out: Segment[] = [];
  let prevLines: string[] = [];
  for (const cue of parseCues(input)) {
    const k = overlap(prevLines, cue.lines);
    const fresh = cue.lines.slice(k);
    prevLines = cue.lines;
    const last = out.at(-1);
    if (fresh.length === 0) {
      // Nothing new. An identical, longer cue that follows straight on extends the previous segment.
      const same = last && k > 0 && last.text === cue.lines.join(' ');
      if (same && cue.start <= last.endSec + 0.05 && cue.end - cue.start > 0.05) last.endSec = Math.max(last.endSec, cue.end);
      continue;
    }
    const seg: Segment = { startSec: cue.start, endSec: cue.end, text: fresh.join(' ') };
    if (cue.speaker) seg.speaker = cue.speaker;
    out.push(seg);
  }
  return out;
}
