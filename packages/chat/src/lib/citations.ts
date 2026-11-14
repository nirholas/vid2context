/**
 * `[n]` citation markers. The answer cites sources as [n] (also [1, 3],
 * [2-4] or [1][2]), where n matches meta.sources[].n. These helpers split text into
 * plain parts and citation parts, label a chip "Title @ m:ss", and turn the
 * markers into timestamp links for Markdown export.
 */
import { formatTimestamp } from '@vid2context/core';
import type { ChatSource, Citation } from './types.ts';

/**
 * Matches [3], [1, 3] and ranges [2-4] (as packages/ask accepts them), plus
 * the lenticular form some models write, like gpt-oss: 【3】 or 【3†L1-L4】.
 * Not [a], footnote-style [^1], or Markdown links [1](url).
 */
export const CITE_RE = /\[(\d{1,3}(?:\s*(?:,|-|\u2013)\s*\d{1,3})*)\]|\u3010(\d{1,3}(?:\s*,\s*\d{1,3})*)(?:\u2020[^\u3011]*)?\u3011/g;

export type CitePart = { kind: 'text'; text: string } | { kind: 'cite'; ns: number[]; raw: string };

/** "1, 3" -> [1, 3]; "2-4" -> [2, 3, 4] (short ascending ranges only, like packages/ask). */
export function expandCiteBody(body: string): number[] {
  const out: number[] = [];
  for (const part of body.split(',')) {
    const range = part.split(/-|\u2013/).map((x) => Number(x.trim()));
    const [a, b] = range;
    if (range.length === 2 && Number.isInteger(a) && Number.isInteger(b) && a !== undefined && b !== undefined) {
      if (b >= a && b - a <= 20) for (let n = a; n <= b; n++) out.push(n);
      else out.push(a, b);
    } else {
      for (const n of range) if (Number.isInteger(n)) out.push(n);
    }
  }
  return out;
}

export function splitCitations(text: string): CitePart[] {
  const out: CitePart[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE_RE)) {
    const start = m.index ?? 0;
    // Skip Markdown links: [1](url) is a link, not a citation.
    if (text[start + m[0].length] === '(') continue;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'cite', ns: expandCiteBody(m[1] ?? m[2] ?? ''), raw: m[0] });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Distinct cited numbers in the order they first appear. */
export function citedNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const part of splitCitations(text)) {
    if (part.kind === 'cite') for (const n of part.ns) seen.add(n);
  }
  return [...seen];
}

const MAX_TITLE = 32;

export function shortTitle(title: string, max = MAX_TITLE): string {
  const t = title.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** "Best & Worst G-Wagon Years @ 3:07". */
export function chipLabel(source: ChatSource, max = MAX_TITLE): string {
  return `${shortTitle(source.title, max)} @ ${formatTimestamp(source.startSec)}`;
}

export function sourceByNumber(sources: ChatSource[] | undefined, n: number): ChatSource | undefined {
  return sources?.find((s) => s.n === n);
}

/** The Citation records for the [n] markers in `text`. Unknown numbers are dropped. */
export function citationsFromText(text: string, sources: ChatSource[]): Citation[] {
  const out: Citation[] = [];
  for (const n of citedNumbers(text)) {
    const s = sourceByNumber(sources, n);
    if (!s) continue;
    out.push({ n, videoId: s.videoId, title: s.title, startSec: s.startSec, endSec: s.endSec, ...(s.url ? { url: s.url } : {}) });
  }
  return out;
}

/** Replace [n] markers with Markdown timestamp links for export. */
export function citationsToLinks(text: string, sources: ChatSource[] | undefined): string {
  return splitCitations(text)
    .map((part) => {
      if (part.kind === 'text') return part.text;
      const links = part.ns.map((n) => {
        const s = sourceByNumber(sources, n);
        if (!s) return `[${n}]`;
        const label = `${s.title.replace(/[[\]]/g, '')} @ ${formatTimestamp(s.startSec)}`;
        return s.url ? `[${label}](${s.url})` : `(${label})`;
      });
      return links.join(' ');
    })
    .join('');
}
