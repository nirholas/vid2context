/**
 * Citation verification. A model's claim is only presented as cited when its
 * quote is really in the transcript near the timestamp it gave.
 *
 * Rules (documented in docs/guides/briefs.md):
 *
 * - Quote and transcript are normalized the same way: lowercase, no
 *   diacritics, no punctuation, apostrophes joined ("you're" -> "youre"),
 *   whitespace collapsed. Auto-captions have no case or punctuation, so this
 *   is the only fair comparison.
 * - The quote needs at least MIN_QUOTE_TOKENS words; shorter quotes match
 *   almost anywhere and prove nothing.
 * - The search window is every segment overlapping startSec plus or minus
 *   WINDOW_SEC (30 s), extended by the quote's own length.
 * - Score: slide a span of ceil(1.25 x quote words) transcript words over the
 *   window and count how many quote words it contains (multiset overlap,
 *   order ignored). Score = best count / quote words. A claim passes at
 *   THRESHOLD (0.8) or more: an exact quote scores 1.0; a quote with one word
 *   in five changed or misheard still passes; a paraphrase in different words
 *   fails.
 * - On a pass, startSec is snapped to the start of the segment holding the
 *   first matched word, and endSec to the end of the segment holding the last.
 * - On a fail, the whole transcript is searched. If the quote is there at a
 *   different time the claim is rejected as quote-at-other-time with the real
 *   time in `foundAtSec` (the model mixed up its sources, so the claim is not
 *   trusted), otherwise quote-not-found.
 */
import { formatTimestamp, timestampUrl, type VideoContext } from '@vid2context/core';
import { type Source, type SourceSet, sourceSet } from './sources.ts';
import { normalize, parseSeconds } from './text.ts';
import type { Claim, RawClaim, UnverifiedClaim, UnverifiedReason } from './types.ts';

export const WINDOW_SEC = 30;
export const THRESHOLD = 0.8;
export const MIN_QUOTE_TOKENS = 4;
const SPAN_FACTOR = 1.25;

interface TokenStream {
  words: string[];
  /** Segment index of each word. */
  seg: number[];
}

const streams = new WeakMap<VideoContext, TokenStream>();

function streamOf(context: VideoContext): TokenStream {
  const cached = streams.get(context);
  if (cached) return cached;
  const words: string[] = [];
  const seg: number[] = [];
  context.transcript.segments.forEach((s, i) => {
    const n = normalize(s.text);
    if (!n) return;
    for (const w of n.split(' ')) {
      words.push(w);
      seg.push(i);
    }
  });
  const out = { words, seg };
  streams.set(context, out);
  return out;
}

export interface QuoteMatch {
  /** Overlap score 0..1 of the best span. */
  score: number;
  /** Word index range of the best span's matched words, inclusive; -1 when nothing matched. */
  first: number;
  last: number;
}

/** Best multiset overlap of `quote` words within words[from..to), using a sliding span. */
function bestSpan(stream: TokenStream, quote: string[], from: number, to: number): QuoteMatch {
  const n = quote.length;
  const need = new Map<string, number>();
  for (const w of quote) need.set(w, (need.get(w) ?? 0) + 1);
  const span = Math.max(n, Math.ceil(n * SPAN_FACTOR));
  const have = new Map<string, number>();
  let overlap = 0;
  let best = { overlap: 0, start: from };
  const add = (w: string) => {
    const h = have.get(w) ?? 0;
    if (h < (need.get(w) ?? 0)) overlap++;
    have.set(w, h + 1);
  };
  const remove = (w: string) => {
    const h = (have.get(w) ?? 0) - 1;
    have.set(w, h);
    if (h < (need.get(w) ?? 0)) overlap--;
  };
  for (let i = from; i < to; i++) {
    add(stream.words[i] as string);
    if (i - from >= span) remove(stream.words[i - span] as string);
    if (overlap > best.overlap) best = { overlap, start: Math.max(from, i - span + 1) };
  }
  if (best.overlap === 0) return { score: 0, first: -1, last: -1 };
  // The matched words inside the best span: first and last word that belongs to the quote.
  const end = Math.min(to, best.start + span);
  let first = -1;
  let last = -1;
  for (let i = best.start; i < end; i++) {
    if (need.has(stream.words[i] as string)) {
      if (first === -1) first = i;
      last = i;
    }
  }
  return { score: best.overlap / n, first, last };
}

export interface VerifyResult {
  ok: boolean;
  reason?: UnverifiedReason;
  detail: string;
  score: number;
  /** Snapped start and end of the matched text (on ok). */
  startSec?: number;
  endSec?: number;
  /** Where the quote really is (quote-at-other-time). */
  foundAtSec?: number;
}

/** Check one quote against one transcript near `startSec`. */
export function verifyQuote(
  context: VideoContext,
  quote: unknown,
  startSec: unknown,
  opts: { windowSec?: number; threshold?: number } = {},
): VerifyResult {
  const windowSec = opts.windowSec ?? WINDOW_SEC;
  const threshold = opts.threshold ?? THRESHOLD;
  if (typeof quote !== 'string' || !quote.trim()) return { ok: false, reason: 'no-quote', detail: 'The claim has no quote.', score: 0 };
  const q = normalize(quote).split(' ').filter(Boolean);
  if (q.length < MIN_QUOTE_TOKENS) {
    return {
      ok: false,
      reason: 'quote-too-short',
      detail: `The quote has ${q.length} words; at least ${MIN_QUOTE_TOKENS} are needed to prove where it is.`,
      score: 0,
    };
  }
  const t = parseSeconds(startSec);
  if (Number.isNaN(t)) return { ok: false, reason: 'bad-timestamp', detail: `"${String(startSec)}" is not a timestamp.`, score: 0 };

  const stream = streamOf(context);
  const segs = context.transcript.segments;
  const span = Math.ceil(q.length * SPAN_FACTOR);
  let from = stream.seg.findIndex((s) => (segs[s]?.endSec ?? 0) >= t - windowSec);
  if (from === -1) from = stream.words.length;
  let to = from;
  while (to < stream.words.length && (segs[stream.seg[to] as number]?.startSec ?? 0) <= t + windowSec) to++;
  to = Math.min(stream.words.length, to + span);

  const near = bestSpan(stream, q, from, to);
  if (near.score >= threshold) {
    const a = segs[stream.seg[near.first] as number];
    const b = segs[stream.seg[near.last] as number];
    return {
      ok: true,
      detail: `Matched ${Math.round(near.score * 100)}% of the quote's words at ${formatTimestamp(a?.startSec ?? t)}.`,
      score: near.score,
      startSec: a?.startSec ?? t,
      endSec: b?.endSec,
    };
  }
  const anywhere = bestSpan(stream, q, 0, stream.words.length);
  if (anywhere.score >= threshold) {
    const at = segs[stream.seg[anywhere.first] as number]?.startSec ?? 0;
    return {
      ok: false,
      reason: 'quote-at-other-time',
      detail: `The quote is at ${formatTimestamp(at)}, not within ${windowSec} s of ${formatTimestamp(t)}.`,
      score: near.score,
      foundAtSec: at,
    };
  }
  return {
    ok: false,
    reason: 'quote-not-found',
    detail: `Best match near ${formatTimestamp(t)} covers ${Math.round(Math.max(near.score, anywhere.score) * 100)}% of the quote's words (needs ${Math.round(threshold * 100)}%).`,
    score: Math.max(near.score, anywhere.score),
  };
}

function rawStart(v: unknown): number | undefined {
  const n = parseSeconds(v);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Verify every claim against the transcripts. Verified claims get ids (c1,
 * c2, ...), a snapped startSec and a timestamp link. The rest are returned as
 * unverified with the reason; callers must never present them as cited.
 */
export function verifyCitations(
  claims: RawClaim[],
  contexts: VideoContext[] | SourceSet,
  opts: { windowSec?: number; threshold?: number } = {},
): { verified: Claim[]; unverified: UnverifiedClaim[] } {
  const set = Array.isArray(contexts) ? sourceSet(contexts) : contexts;
  const verified: Claim[] = [];
  const unverified: UnverifiedClaim[] = [];
  for (const c of claims) {
    const source: Source | undefined = set.find(c.videoId);
    const base = {
      claim: String(c.claim ?? ''),
      quote: typeof c.quote === 'string' ? c.quote : undefined,
      topic: typeof c.topic === 'string' ? c.topic : undefined,
      startSec: rawStart(c.startSec),
    };
    if (!source) {
      unverified.push({
        ...base,
        videoId: typeof c.videoId === 'string' ? c.videoId : undefined,
        reason: 'unknown-video',
        detail: `"${String(c.videoId)}" is not one of the sources.`,
      });
      continue;
    }
    const r = verifyQuote(source.context, c.quote, c.startSec, opts);
    if (!r.ok || r.startSec === undefined) {
      unverified.push({
        ...base,
        videoId: source.summary.videoId,
        reason: r.reason ?? 'quote-not-found',
        detail: r.detail,
        ...(r.foundAtSec !== undefined ? { foundAtSec: r.foundAtSec } : {}),
      });
      continue;
    }
    const ref = source.context.metadata.ref;
    verified.push({
      id: `c${verified.length + 1}`,
      claim: base.claim,
      topic: base.topic?.trim() || 'general',
      ...(typeof c.stance === 'string' && c.stance.trim() ? { stance: c.stance.trim() } : {}),
      videoId: source.summary.videoId,
      citation: {
        videoId: source.summary.videoId,
        title: source.summary.title,
        startSec: r.startSec,
        ...(r.endSec !== undefined ? { endSec: r.endSec } : {}),
        ...(timestampUrl(ref, r.startSec) ? { url: timestampUrl(ref, r.startSec) } : {}),
        quote: String(c.quote),
      },
      score: r.score,
    });
  }
  return { verified, unverified };
}
