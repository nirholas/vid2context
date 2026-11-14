/**
 * Parsers for YouTube's timedtext payloads.
 *
 * srv3 (fmt=srv3): <timedtext format="3"><body><p t="startMs" d="durMs">text</p>
 *   Auto-captions put each word in <s> elements and add empty "append" <p a="1">
 *   paragraphs between lines; both are handled.
 * srv1 (no fmt):   <transcript><text start="sec" dur="sec">text</text>
 *   Text is entity-encoded twice (&amp;#39;), so it is decoded twice.
 * json3 (fmt=json3): {"events":[{"tStartMs","dDurationMs","segs":[{"utf8"}]}]}
 *   Auto-captions add "aAppend" events holding only a newline; they are skipped.
 * WebVTT (fmt=vtt): "WEBVTT" then cues "00:00:01.200 --> 00:00:03.360".
 *   Auto-caption VTT repeats the previous line at the top of every cue and
 *   carries per-word <00:00:01.500><c> tags; the repeats are dropped.
 *
 * The endpoint does not always honour the requested fmt (a live test on
 * 2026-11-14 got srv3 back for &fmt=json3), so parseTimedText detects the
 * format from the body, never from the request.
 */
import { decodeEntities, type Segment } from '@vid2context/core';

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
}

function cleanText(inner: string, decodeTimes: number): string {
  let s = inner.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
  for (let i = 0; i < decodeTimes; i++) s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

/** Clamp each segment's end to the next segment's start, so rolling auto-captions do not overlap. */
function unoverlap(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (cur && next && next.startSec < cur.endSec) cur.endSec = Math.max(cur.startSec, next.startSec);
  }
  return sorted;
}

export function parseSrv3(xml: string): Segment[] {
  const out: Segment[] = [];
  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const attrs = m[1] ?? '';
    const text = cleanText(m[2] ?? '', 1);
    if (!text) continue;
    const t = Number(attr(attrs, 't'));
    const d = Number(attr(attrs, 'd') ?? 0);
    if (!Number.isFinite(t)) continue;
    out.push({ startSec: t / 1000, endSec: (t + (Number.isFinite(d) ? d : 0)) / 1000, text });
  }
  return unoverlap(out);
}

export function parseSrv1(xml: string): Segment[] {
  const out: Segment[] = [];
  for (const m of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attrs = m[1] ?? '';
    const text = cleanText(m[2] ?? '', 2);
    if (!text) continue;
    const start = Number(attr(attrs, 'start'));
    const dur = Number(attr(attrs, 'dur') ?? 0);
    if (!Number.isFinite(start)) continue;
    out.push({ startSec: start, endSec: start + (Number.isFinite(dur) ? dur : 0), text });
  }
  return unoverlap(out);
}

interface Json3 {
  events?: { tStartMs?: number; dDurationMs?: number; aAppend?: number; segs?: { utf8?: string }[] }[];
}

export function parseJson3(body: string): Segment[] {
  let doc: Json3;
  try {
    doc = JSON.parse(body) as Json3;
  } catch {
    return [];
  }
  const out: Segment[] = [];
  for (const e of doc.events ?? []) {
    if (!e.segs || e.aAppend) continue;
    const text = e.segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    const start = Number(e.tStartMs);
    if (!text || !Number.isFinite(start)) continue;
    const dur = Number(e.dDurationMs ?? 0);
    out.push({ startSec: start / 1000, endSec: (start + (Number.isFinite(dur) ? dur : 0)) / 1000, text });
  }
  return unoverlap(out);
}

/** "01:02:03.450" or "02:03.450" to seconds. */
function vttTime(s: string): number {
  const parts = s.trim().split(':');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  return sec;
}

export function parseVtt(body: string): Segment[] {
  const text = body.replace(/^\uFEFF/, '');
  if (!/^WEBVTT/.test(text)) return [];
  // Per-word timing tags mark YouTube's rolling auto-caption VTT.
  const rolling = /<\d{2}:\d{2}[:.]\d/.test(text) || /<c>/.test(text);
  const out: Segment[] = [];
  let prevLines: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing < 0) continue;
    const [from, rest] = (lines[timing] ?? '').split('-->');
    const start = vttTime(from ?? '');
    const end = vttTime((rest ?? '').trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const cueLines = lines
      .slice(timing + 1)
      .map((l) => cleanText(l, 1))
      .filter(Boolean);
    const fresh = rolling ? cueLines.filter((l) => !prevLines.includes(l)) : cueLines;
    prevLines = cueLines;
    const t = fresh.join(' ').trim();
    if (t) out.push({ startSec: start, endSec: end, text: t });
  }
  return unoverlap(out);
}

export type TimedTextFormat = 'srv3' | 'srv1' | 'json3' | 'vtt';

/** Which format a timedtext body is in, or null for an empty or unknown body. */
export function detectFormat(body: string): TimedTextFormat | null {
  const head = body
    .replace(/^\uFEFF/, '')
    .trimStart()
    .slice(0, 200);
  if (head.startsWith('{')) return 'json3';
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/<timedtext\b[^>]*format="3"/.test(body)) return 'srv3';
  if (/<transcript\b/.test(head)) return 'srv1';
  return null;
}

/** Detect the payload format and parse it. Returns [] for an empty or unknown payload. */
export function parseTimedText(body: string): Segment[] {
  switch (detectFormat(body)) {
    case 'srv3':
      return parseSrv3(body);
    case 'srv1':
      return parseSrv1(body);
    case 'json3':
      return parseJson3(body);
    case 'vtt':
      return parseVtt(body);
    default:
      return [];
  }
}
