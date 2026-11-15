/**
 * Podcasting 2.0 transcripts (`podcast:transcript`) to segments: WebVTT, SRT,
 * the JSON transcript format and, when nothing timed exists, HTML.
 *
 * Preference follows timing quality: VTT and SRT carry cue timing and VTT
 * often the speaker; JSON is often word-level (merged here into phrases);
 * HTML only sometimes carries paragraph times.
 */
import { decodeEntities, type Segment } from '@vid2context/core';
import type { TranscriptLink } from './feed.ts';

export type TranscriptFormat = 'vtt' | 'srt' | 'json' | 'html';

const TYPES: Record<string, TranscriptFormat> = {
  'text/vtt': 'vtt',
  'application/x-subrip': 'srt',
  'application/srt': 'srt',
  'application/x-srt': 'srt',
  'text/srt': 'srt',
  'text/x-srt': 'srt',
  'application/json': 'json',
  'text/json': 'json',
  'text/html': 'html',
};

const RANK: Record<TranscriptFormat, number> = { vtt: 0, srt: 1, json: 2, html: 3 };

/** Format of a transcript link from its type, falling back to the URL's extension. */
export function transcriptFormat(t: TranscriptLink): TranscriptFormat | undefined {
  const byType = TYPES[t.type];
  if (byType) return byType;
  const ext = /\.(vtt|srt|json|html?)(?:[?#]|$)/i.exec(t.url)?.[1]?.toLowerCase();
  if (ext === 'vtt' || ext === 'srt' || ext === 'json') return ext;
  if (ext === 'html' || ext === 'htm') return 'html';
  return undefined;
}

function langMatches(a: string | undefined, want: string): boolean {
  if (!a) return false;
  const x = a.toLowerCase();
  const y = want.toLowerCase();
  return x === y || x.split('-')[0] === y.split('-')[0];
}

/** Supported transcripts, best first: requested language first, then VTT, SRT, JSON, HTML. */
export function rankTranscripts(list: TranscriptLink[], language?: string): (TranscriptLink & { format: TranscriptFormat })[] {
  const out: (TranscriptLink & { format: TranscriptFormat; i: number })[] = [];
  list.forEach((t, i) => {
    const format = transcriptFormat(t);
    if (format) out.push({ ...t, format, i });
  });
  out.sort((a, b) => {
    if (language) {
      const la = langMatches(a.language, language) ? 0 : 1;
      const lb = langMatches(b.language, language) ? 0 : 1;
      if (la !== lb) return la - lb;
    }
    return RANK[a.format] - RANK[b.format] || a.i - b.i;
  });
  return out.map(({ i: _i, ...t }) => t);
}

// ---------------------------------------------------------------- VTT and SRT

const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;

/** "01:02:03.500", "01:02:03,500" or "02:03.5" to seconds. */
export function cueTime(stamp: string): number {
  let sec = 0;
  for (const p of stamp.replace(',', '.').split(':')) sec = sec * 60 + Number(p);
  return Math.round(sec * 1000) / 1000;
}

function stripTags(line: string): { text: string; voice?: string } {
  let voice: string | undefined;
  const text = line.replace(/<\/?([a-z0-9]+)?(?:\.[^\s>]*)?(?:\s+([^>]*))?>|<\d[^>]*>/gi, (_m, tag?: string, ann?: string) => {
    if (tag?.toLowerCase() === 'v' && ann && voice === undefined) voice = ann.trim();
    return '';
  });
  return { text: decodeEntities(text).replace(/\s+/g, ' ').trim(), voice };
}

interface Cue {
  start: number;
  end: number;
  text: string;
  voice?: string;
}

function parseCues(raw: string): Cue[] {
  const blocks = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => TIMING.test(l));
    if (at === -1) continue;
    const m = TIMING.exec(lines[at] ?? '');
    if (!m?.[1] || !m[2]) continue;
    let voice: string | undefined;
    const parts: string[] = [];
    for (const l of lines.slice(at + 1)) {
      const c = stripTags(l);
      voice ??= c.voice;
      if (c.text) parts.push(c.text);
    }
    const text = parts.join(' ').trim();
    if (!text) continue;
    cues.push({ start: cueTime(m[1]), end: cueTime(m[2]), text, ...(voice ? { voice } : {}) });
  }
  return cues;
}

const LABEL = /^([A-Z][\p{L}\p{N}.'-]*(?: [A-Z][\p{L}\p{N}.'-]*){0,3}):\s+(.+)$/u;

/**
 * Cues to segments. Speakers come from VTT voice spans or, in SRT and VTT
 * without voices, from "Name: text" labels at the start of a turn (the form
 * Buzzsprout and others write). Labels are only trusted when one repeats or
 * several distinct ones appear, and the speaker carries over until the next
 * label.
 */
function cuesToSegments(cues: Cue[]): Segment[] {
  const labels = new Map<string, number>();
  for (const c of cues) {
    const m = LABEL.exec(c.text);
    if (m?.[1]) labels.set(m[1], (labels.get(m[1]) ?? 0) + 1);
  }
  const trustLabels = labels.size >= 2 || [...labels.values()].some((n) => n >= 2);
  let current: string | undefined;
  return cues.map((c) => {
    let text = c.text;
    let speaker = c.voice;
    if (!speaker && trustLabels) {
      const m = LABEL.exec(text);
      if (m?.[1] && m[2] && labels.has(m[1])) {
        current = m[1];
        text = m[2];
      }
      speaker = current;
    }
    return { startSec: c.start, endSec: Math.max(c.end, c.start), text, ...(speaker ? { speaker } : {}) };
  });
}

/** WebVTT or SRT to segments. */
export function parseSubtitles(raw: string): Segment[] {
  return cuesToSegments(parseCues(raw));
}

// ---------------------------------------------------------------- JSON

interface JsonSegment {
  startTime?: number | string;
  endTime?: number | string;
  body?: string;
  speaker?: string;
}

/**
 * The Podcasting 2.0 JSON transcript format. Word-level files (one word per
 * segment) are merged into phrases: same speaker, gaps under 1.5 s, broken
 * after sentence ends once a phrase passes 5 s, and always by 20 s.
 */
export function parseJsonTranscript(raw: string): Segment[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (data as { segments?: unknown }).segments;
  if (!Array.isArray(list)) return [];
  const segs: Segment[] = [];
  for (const s of list as JsonSegment[]) {
    const start = Number(s.startTime);
    const end = Number(s.endTime);
    const text = decodeEntities(String(s.body ?? ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!Number.isFinite(start) || !text) continue;
    segs.push({
      startSec: start,
      endSec: Number.isFinite(end) && end >= start ? end : start,
      text,
      ...(s.speaker ? { speaker: String(s.speaker).trim() } : {}),
    });
  }
  const wordLevel = segs.length > 0 && segs.filter((s) => !s.text.includes(' ')).length / segs.length > 0.8;
  if (!wordLevel) return segs;
  const out: Segment[] = [];
  let cur: Segment | undefined;
  for (const s of segs) {
    const dur = cur ? s.endSec - cur.startSec : 0;
    const split =
      !cur ||
      cur.speaker !== s.speaker ||
      s.startSec - cur.endSec > 1.5 ||
      dur > 20 ||
      (/[.?!]["')\]]?$/.test(cur.text) && cur.endSec - cur.startSec >= 5);
    if (split) {
      if (cur) out.push(cur);
      cur = { ...s };
    } else if (cur) {
      cur.text += ` ${s.text}`;
      cur.endSec = Math.max(cur.endSec, s.endSec);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- HTML

/**
 * An HTML transcript: one segment per paragraph. A `<cite>` before a
 * paragraph names its speaker; a `<time>` (or the first `data-t` word stamp)
 * gives its start, and each paragraph ends where the next starts. `timed` is
 * false when the page has no times at all; every segment then sits at 0.
 */
export function parseHtmlTranscript(raw: string): { segments: Segment[]; timed: boolean } {
  const body = raw.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const token = /<cite\b[^>]*>([\s\S]*?)<\/cite>|<time\b[^>]*>([\s\S]*?)<\/time>|<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  const paras: { start?: number; text: string; speaker?: string }[] = [];
  let speaker: string | undefined;
  let time: number | undefined;
  for (const m of body.matchAll(token)) {
    if (m[1] !== undefined) {
      speaker = stripTags(m[1]).text || undefined;
    } else if (m[2] !== undefined) {
      const t = stripTags(m[2]).text;
      if (/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) time = cueTime(t);
    } else if (m[3] !== undefined) {
      const stamp = /data-t="([\d.]+)"/.exec(m[3])?.[1];
      const text = stripTags(m[3]).text;
      if (!text) continue;
      const start = time ?? (stamp ? Number(stamp) : undefined);
      paras.push({ text, ...(start !== undefined ? { start } : {}), ...(speaker ? { speaker } : {}) });
      time = undefined;
    }
  }
  const timed = paras.some((p) => p.start !== undefined);
  const segments: Segment[] = [];
  let last = 0;
  paras.forEach((p, i) => {
    const start = timed ? (p.start ?? last) : 0;
    last = start;
    let end = start;
    if (timed) {
      for (let j = i + 1; j < paras.length; j++) {
        const next = paras[j]?.start;
        if (next !== undefined) {
          end = Math.max(start, next);
          break;
        }
      }
    }
    segments.push({ startSec: start, endSec: end, text: p.text, ...(p.speaker ? { speaker: p.speaker } : {}) });
  });
  return { segments, timed };
}
