/**
 * Citation checking. The model cites sources as `[n]` (also `[1, 3]`,
 * `[2-4]`, and gpt-oss's native lenticular-bracket form, rewritten to `[n]`). Every number must name an existing source: unknown numbers are
 * removed from the text and reported as unverified. The streaming filter
 * applies the same rule to deltas, holding back an unfinished `[...` until
 * its `]` arrives, so streamed text and the final text always agree.
 */
import { type Segment, timestampUrl, type VideoContext } from '@vid2context/core';
import { keywords } from './retrieve.ts';
import type { Citation, Source } from './types.ts';

/** A bracket whose content is only numbers, commas, spaces and ranges. */
const MARKER = /\s?\[(\d{1,3}(?:\s*(?:,|-|\u2013)\s*\d{1,3})*)\]/g;
/** Prefix of a marker that may still complete. */
const PARTIAL = /(?:\[[\d,\s\-\u2013]{0,24}|\u3010[^\u3011\n]{0,40})$/;
/**
 * gpt-oss models cite in their native browsing format, `\u30107\u2020L0-L4\u3011`
 * (lenticular brackets, a dagger, line numbers). The number before the dagger
 * is the source number; the rest is dropped.
 */
const NATIVE = /\u3010(\d{1,3})(?:\u2020[^\u3011\n]{0,40})?\u3011/g;

/** Rewrite native `\u3010n\u2020...\u3011` markers as `[n]`. */
export function normalizeMarkers(text: string): string {
  return text.replace(NATIVE, (_m, n: string) => `[${n}]`);
}

function expand(body: string): number[] {
  const out: number[] = [];
  for (const part of body.split(',')) {
    const range = part.split(/-|\u2013/).map((s) => Number(s.trim()));
    if (range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1])) {
      const [a, b] = range as [number, number];
      // A short ascending range is a citation range; anything else is kept as two numbers.
      if (b >= a && b - a <= 20) for (let n = a; n <= b; n++) out.push(n);
      else out.push(a, b);
    } else {
      for (const n of range) if (Number.isInteger(n)) out.push(n);
    }
  }
  return out;
}

export interface Rewritten {
  text: string;
  /** Valid source numbers in order of first use. */
  used: number[];
  /** Numbers that matched no source, in order of first use. */
  unverified: number[];
}

/** Rewrite every marker in `text`, keeping only numbers in `valid`. */
export function rewriteCitations(
  text: string,
  valid: Set<number>,
  acc: Rewritten = { text: '', used: [], unverified: [] },
): Rewritten {
  const out = normalizeMarkers(text).replace(MARKER, (whole, body: string) => {
    const nums = expand(body);
    const good = nums.filter((n) => valid.has(n));
    for (const n of nums) {
      const list = valid.has(n) ? acc.used : acc.unverified;
      if (!list.includes(n)) list.push(n);
    }
    if (good.length === nums.length) return whole;
    const lead = whole.startsWith(' ') || whole.startsWith('\n') ? (whole[0] as string) : '';
    return good.length > 0 ? `${lead}${good.map((n) => `[${n}]`).join('')}` : '';
  });
  acc.text += out;
  return acc;
}

/** Streaming version of rewriteCitations: push deltas in, get safe text out. */
export class CitationFilter {
  private pending = '';
  readonly state: Rewritten = { text: '', used: [], unverified: [] };

  constructor(private readonly valid: Set<number>) {}

  /** Feed a delta; returns the text that is safe to emit now (possibly empty). */
  push(delta: string): string {
    const buf = this.pending + delta;
    const partial = PARTIAL.exec(buf);
    // Hold back a trailing "[12, " that might still become a marker.
    let cut = partial ? partial.index : buf.length;
    // Trailing whitespace too: a marker may start in the next delta, and its leading space goes with it.
    while (cut > 0 && /\s/.test(buf[cut - 1] as string)) cut--;
    this.pending = buf.slice(cut);
    return this.emit(buf.slice(0, cut));
  }

  /** Flush whatever is held back at the end of the stream. */
  end(): string {
    const rest = this.pending;
    this.pending = '';
    return this.emit(rest);
  }

  private emit(text: string): string {
    if (!text) return '';
    const before = this.state.text.length;
    rewriteCitations(text, this.valid, this.state);
    return this.state.text.slice(before);
  }
}

/**
 * How much a shared word says about where a claim is supported: numbers count
 * double (the most specific part of a claim), and a word is worth less the
 * more segments of the source repeat it, so "491" beats "G55" in a stretch
 * that keeps saying "G55".
 */
function weight(w: string, df: Map<string, number>): number {
  return (/\d/.test(w) ? 2 : 1) / (df.get(w) ?? 1);
}

/** The sentences of the answer that cite `n`. */
function citingText(answer: string, n: number): string {
  const sentences = answer.split(/(?<=[.!?\n])\s+/);
  const re = new RegExp(`\\[${n}\\]`);
  return sentences.filter((s) => re.test(s)).join(' ');
}

/** The segment (with its neighbour) inside the source whose words best match the citing sentences. */
function bestMoment(source: Source, segments: Segment[], claim: string): { startSec: number; endSec: number; quote: string } {
  const inRange = segments.filter((s) => s.endSec > source.startSec && s.startSec < source.endSec && s.text.trim());
  if (inRange.length === 0) return { startSec: source.startSec, endSec: source.endSec, quote: source.text };
  const want = new Set(keywords(claim));
  const df = new Map<string, number>();
  for (const seg of inRange) for (const w of new Set(keywords(seg.text))) df.set(w, (df.get(w) ?? 0) + 1);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < inRange.length; i++) {
    const window = `${inRange[i]?.text ?? ''} ${inRange[i + 1]?.text ?? ''}`;
    let score = 0;
    for (const w of new Set(keywords(window))) if (want.has(w)) score += weight(w, df);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  const a = inRange[best] as Segment;
  const b = inRange[best + 1];
  return { startSec: a.startSec, endSec: (b ?? a).endSec, quote: `${a.text.trim()} ${b?.text.trim() ?? ''}`.trim() };
}

function shorten(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/**
 * Build one Citation per used source number. The timestamp is narrowed to the
 * segment inside the source that best matches the sentences citing it, so the
 * link opens near the supporting words rather than at the start of the range.
 */
export function buildCitations(answer: string, used: number[], sources: Source[], contexts: VideoContext[]): Citation[] {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const byId = new Map(contexts.map((c) => [c.metadata.ref.id, c]));
  const out: Citation[] = [];
  for (const n of used) {
    const source = byN.get(n);
    if (!source) continue;
    const context = byId.get(source.videoId);
    const moment = bestMoment(source, context?.transcript.segments ?? [], citingText(answer, n));
    const url = context ? timestampUrl(context.metadata.ref, moment.startSec) : source.url;
    out.push({
      n,
      videoId: source.videoId,
      title: source.title,
      startSec: moment.startSec,
      endSec: moment.endSec,
      ...(url ? { url } : {}),
      quote: shorten(moment.quote),
    });
  }
  return out;
}
