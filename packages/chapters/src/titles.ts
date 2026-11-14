/**
 * Offline chapter titles: the terms most distinctive of each chapter, scored
 * like tf-idf with chapters as documents. A term frequent in one chapter and
 * rare elsewhere scores high; a term spread over every chapter scores low.
 * Used when no LLM is enabled or the LLM answer is unusable.
 */
import type { Term } from './tokenize.ts';

/** Terms per chapter (segment index ranges are [start, next start)). */
function termsByChapter(terms: Term[], segs: number[]): Term[][] {
  const out: Term[][] = segs.map(() => []);
  let c = 0;
  for (const t of terms) {
    while (c + 1 < segs.length && t.seg >= (segs[c + 1] ?? Number.POSITIVE_INFINITY)) c++;
    out[c]?.push(t);
  }
  return out;
}

/** The `n` most distinctive words of each chapter, as spoken, best first. */
export function distinctiveTerms(terms: Term[], segs: number[], n = 3): string[][] {
  const chapters = termsByChapter(terms, segs);
  const df = new Map<string, number>();
  for (const ch of chapters) for (const s of new Set(ch.map((t) => t.stem))) df.set(s, (df.get(s) ?? 0) + 1);
  const total = chapters.length;
  return chapters.map((ch) => {
    const tf = new Map<string, number>();
    const forms = new Map<string, Map<string, number>>();
    for (const t of ch) {
      tf.set(t.stem, (tf.get(t.stem) ?? 0) + 1);
      const f = forms.get(t.stem) ?? new Map<string, number>();
      f.set(t.word, (f.get(t.word) ?? 0) + 1);
      forms.set(t.stem, f);
    }
    const scored = [...tf.entries()]
      .filter(([, count]) => count >= 2 || ch.length < 40)
      .map(([stem, count]) => ({ stem, score: (count / Math.max(1, ch.length)) * Math.log(1 + total / (df.get(stem) ?? 1)) }))
      .sort((a, b) => b.score - a.score || a.stem.localeCompare(b.stem));
    return scored.slice(0, n).map(({ stem }) => {
      const f = [...(forms.get(stem)?.entries() ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return f[0]?.[0] ?? stem;
    });
  });
}

/** "engine", "m113", "reliability" -> "Engine, m113 and reliability". */
export function titleFromTerms(words: string[], index: number): string {
  if (words.length === 0) return `Part ${index + 1}`;
  const list = words.length === 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  return list.charAt(0).toUpperCase() + list.slice(1);
}
