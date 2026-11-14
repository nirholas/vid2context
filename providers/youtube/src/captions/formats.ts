/**
 * Parsers for YouTube's timedtext payloads.
 *
 * srv3 (fmt=srv3): <timedtext format="3"><body><p t="startMs" d="durMs">text</p>
 *   Auto-captions put each word in <s> elements and add empty "append" <p a="1">
 *   paragraphs between lines; both are handled.
 * srv1 (no fmt):   <transcript><text start="sec" dur="sec">text</text>
 *   Text is entity-encoded twice (&amp;#39;), so it is decoded twice.
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

/** Detect the payload format and parse it. Returns [] for an empty or unknown payload. */
export function parseTimedText(xml: string): Segment[] {
  if (/<timedtext\b[^>]*format="3"/.test(xml)) return parseSrv3(xml);
  if (/<transcript\b/.test(xml)) return parseSrv1(xml);
  return [];
}
