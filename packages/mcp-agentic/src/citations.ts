/**
 * Citation checks for model output. A model can write a timestamp that does
 * not exist (past the end of the video, or in a gap with no speech), so every
 * `[m:ss]` it writes is checked against the real transcript before the text
 * reaches the agent. Lines whose citations fail are dropped and reported, so
 * the agent knows exactly what was removed and why.
 */
import { formatTimestamp, type Segment, timestampUrl, type VideoContext, type VideoRef } from '@vid2context/core';
import { needsHours, videoDuration } from './chunking.ts';

export const DEFAULT_TOLERANCE_SEC = 5;

/** h:mm:ss or m:ss (also mm:ss). */
const TS = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
/**
 * Range separator: hyphen, or any Unicode dash models write (U+2010 to U+2015,
 * minus sign U+2212), as escapes per the house style.
 */
const SEP = String.raw`\s*[-\u2010-\u2015\u2212]\s*`;
/** `[m:ss]` or a range `[m:ss-m:ss]`. */
const BARE = new RegExp(String.raw`\[(${TS})(?:${SEP}(${TS}))?\]`, 'g');
/** A bare marker with an optional `(url)` right after it. */
const BARE_LINKED = new RegExp(String.raw`\[(${TS})(?:${SEP}(${TS}))?\](?:\((\S+?)\))?`, 'g');
/** `[Title @ m:ss]` with an optional range and an optional `(url)` right after. */
const TITLED = new RegExp(String.raw`\[([^\[\]]+?)\s+@\s+(${TS})(?:${SEP}(${TS}))?\](?:\((\S+?)\))?`, 'g');

/**
 * Some models (gpt-oss among them) write citations in CJK lenticular brackets
 * (U+3010, U+3011) or fullwidth square brackets (U+FF3B, U+FF3D). Turn them
 * into ASCII brackets first, so those citations are checked instead of
 * slipping through unverified.
 */
export function normalizeMarkers(text: string): string {
  return text.replace(/[\u3010\uff3b]/g, '[').replace(/[\u3011\uff3d]/g, ']');
}

export function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map((p) => Number(p));
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export interface CitationSource {
  title: string;
  ref: VideoRef;
  durationSec: number;
  segments: Segment[];
  long: boolean;
}

export function sourceOf(context: VideoContext): CitationSource {
  return {
    title: context.metadata.title,
    ref: context.metadata.ref,
    durationSec: videoDuration(context),
    segments: context.transcript.segments,
    long: needsHours(context),
  };
}

export interface CheckOptions {
  /** Seconds a timestamp may sit outside a segment and still count as matching it. Default 5. */
  toleranceSec?: number;
  /** Restrict valid timestamps to this window (the chunk the model was shown). */
  range?: { fromSec: number; toSec: number };
}

/** Why a timestamp is invalid, or undefined when it is valid. */
export function checkTimestamp(source: CitationSource, sec: number, opts: CheckOptions = {}): string | undefined {
  const tol = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (!Number.isFinite(sec) || sec < 0) return 'not a timestamp';
  if (sec > source.durationSec) return `past the end of the video (${formatTimestamp(source.durationSec, source.long)})`;
  if (opts.range && (sec < opts.range.fromSec - tol || sec > opts.range.toSec + tol)) {
    return `outside the part of the transcript the model was given (${formatTimestamp(opts.range.fromSec, source.long)} to ${formatTimestamp(opts.range.toSec, source.long)})`;
  }
  const hit = source.segments.some((s) => s.startSec - tol <= sec && sec <= s.endSec + tol);
  return hit ? undefined : `no transcript segment within ${tol} s`;
}

export interface DroppedClaim {
  text: string;
  reason: string;
}

export interface NotesCheck {
  /** The notes with failing lines removed. */
  text: string;
  /** Lines kept that carry at least one verified timestamp. */
  verified: number;
  dropped: DroppedClaim[];
}

const isBullet = (line: string): boolean => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);

/**
 * Check notes for one chunk of one video. A line with any invalid `[m:ss]` is
 * dropped. A bullet without any timestamp is dropped as uncited. Other lines
 * without timestamps (headings, blank lines) are kept.
 */
export function checkNotes(text: string, source: CitationSource, opts: CheckOptions = {}): NotesCheck {
  const kept: string[] = [];
  const dropped: DroppedClaim[] = [];
  let verified = 0;
  for (const line of normalizeMarkers(text).split('\n')) {
    const stamps = [...line.matchAll(BARE)].flatMap((m) => [m[1], m[2]].filter((s): s is string => Boolean(s)));
    if (stamps.length === 0) {
      if (isBullet(line)) dropped.push({ text: line.trim(), reason: 'no timestamp' });
      else kept.push(line);
      continue;
    }
    const bad = stamps.map((s) => [s, checkTimestamp(source, parseTimestamp(s), opts)] as const).find(([, r]) => r);
    if (bad) {
      dropped.push({ text: line.trim(), reason: `[${bad[0]}] is ${bad[1]}` });
      continue;
    }
    kept.push(line);
    verified++;
  }
  return { text: kept.join('\n').trim(), verified, dropped };
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Find the source a citation points at: by URL first, then by exact (normalized) title, then by unambiguous prefix. */
export function findSource(sources: CitationSource[], title: string, url?: string): CitationSource | undefined {
  if (url) {
    const byUrl = sources.find((s) => url.includes(s.ref.nativeId) || (s.ref.url !== undefined && url.startsWith(s.ref.url)));
    if (byUrl) return byUrl;
  }
  const t = norm(title);
  if (!t) return undefined;
  const exact = sources.filter((s) => norm(s.title) === t);
  if (exact.length === 1) return exact[0];
  const prefix = sources.filter((s) => norm(s.title).startsWith(t) || t.startsWith(norm(s.title)));
  return prefix.length === 1 ? prefix[0] : undefined;
}

export interface DigestCheck {
  /** The digest with citations rewritten to `[Title @ m:ss](timestamp url)` and failing lines removed. */
  text: string;
  /** Citations kept, all verified. */
  citations: number;
  dropped: DroppedClaim[];
}

function link(source: CitationSource, startSec: number, label: string): string {
  const url = timestampUrl(source.ref, startSec) ?? source.ref.url;
  return url ? `[${label}](${url})` : `[${label}]`;
}

/**
 * Check a digest that cites `[Title @ m:ss]`. Every citation must name a known
 * source and a timestamp that exists in it. Valid citations are rewritten to
 * the canonical title and a deep link built by `timestampUrl`, so the model
 * never has to produce URLs. A line with any failing citation is dropped.
 *
 * A bare `[m:ss]` is attributed only when that is unambiguous: to the source
 * its URL names, else to the one source the line already cites by title, else
 * to the only source in which that moment exists. Otherwise its line is
 * dropped, because the claim cannot be traced to a video.
 */
export function checkDigest(text: string, sources: CitationSource[], opts: CheckOptions = {}): DigestCheck {
  const kept: string[] = [];
  const dropped: DroppedClaim[] = [];
  let citations = 0;
  const stampsOf = (from: string, to?: string) => [from, to].filter((s): s is string => Boolean(s));
  for (const line of normalizeMarkers(text).split('\n')) {
    let failure: string | undefined;
    let count = 0;
    const cited = new Set<CitationSource>();
    let out = line.replace(TITLED, (whole, title: string, from: string, to: string | undefined, url: string | undefined) => {
      const source = findSource(sources, title, url);
      if (!source) {
        failure ??= `"${title.trim()}" is not one of the sources`;
        return whole;
      }
      for (const ts of stampsOf(from, to)) {
        const reason = checkTimestamp(source, parseTimestamp(ts), opts);
        if (reason) {
          failure ??= `[${source.title} @ ${ts}] is ${reason}`;
          return whole;
        }
      }
      count++;
      cited.add(source);
      const startSec = parseTimestamp(from);
      const label = `${source.title} @ ${formatTimestamp(startSec, source.long)}${to ? `-${formatTimestamp(parseTimestamp(to), source.long)}` : ''}`;
      return link(source, startSec, label);
    });
    if (!failure) {
      out = out.replace(BARE_LINKED, (whole, from: string, to: string | undefined, url: string | undefined) => {
        const stamps = stampsOf(from, to);
        const fits = (s: CitationSource) => stamps.every((ts) => !checkTimestamp(s, parseTimestamp(ts), opts));
        let candidates: CitationSource[];
        if (url) {
          const byUrl = findSource(sources, '', url);
          candidates = byUrl ? [byUrl] : [];
        } else {
          candidates = cited.size > 0 ? [...cited] : sources;
        }
        const matching = candidates.filter(fits);
        const source = matching.length === 1 ? matching[0] : undefined;
        if (!source) {
          if (candidates.length === 1 && candidates[0]) {
            const reason = stamps
              .map((ts) => checkTimestamp(candidates[0] as CitationSource, parseTimestamp(ts), opts))
              .find(Boolean);
            failure ??= `[${from}] is ${reason}`;
          } else if (matching.length === 0) {
            failure ??= `[${from}] does not exist in any of the sources`;
          } else {
            failure ??= `[${from}] does not say which video it cites`;
          }
          return whole;
        }
        count++;
        const startSec = parseTimestamp(from);
        return link(source, startSec, `${source.title} @ ${formatTimestamp(startSec, source.long)}`);
      });
    }
    if (failure) {
      dropped.push({ text: line.trim(), reason: failure });
      continue;
    }
    citations += count;
    kept.push(out);
  }
  return { text: kept.join('\n').trim(), citations, dropped };
}

/**
 * Re-verify a checked digest: every titled citation whose source or timestamp
 * does not validate, plus any bare `[m:ss]` marker left outside a link (it was
 * never attributed to a video). Empty means every citation checks out.
 */
export function invalidCitations(text: string, sources: CitationSource[], opts: CheckOptions = {}): string[] {
  const bad: string[] = [];
  const normalized = normalizeMarkers(text);
  for (const m of normalized.matchAll(TITLED)) {
    const [whole, title, from, to, url] = m;
    const source = findSource(sources, title ?? '', url);
    const stamps = [from, to].filter((s): s is string => Boolean(s));
    if (!source || stamps.some((s) => checkTimestamp(source, parseTimestamp(s), opts))) bad.push(whole);
  }
  for (const m of normalized.matchAll(BARE)) bad.push(m[0]);
  return bad;
}
