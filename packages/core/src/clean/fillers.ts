/**
 * Filler removal (opt-in). Drops standalone hesitation sounds only: um, uh,
 * erm, er, hmm and their stretched spellings ("umm", "uhh"). Words that carry
 * meaning in some sentences ("like", "so", "well", "ah", "uh-huh") always stay.
 */
import type { Segment } from '../types.ts';
import { addCleanExample, type CleanReport, cleanSplitWords, emptyCleanReport } from './report.ts';

const FILLER = /^(?:u+m+|u+h+|uhm+|e+r+m+|e+r+|ehm+|hm+)$/;

function isFiller(word: string): boolean {
  return FILLER.test(word.toLowerCase().replace(/[^\p{L}]/gu, '')) && !word.includes('-');
}

export function removeFillers(segments: readonly Segment[]): { segments: Segment[]; report: CleanReport } {
  const report = emptyCleanReport('remove-fillers');
  const out: Segment[] = [];
  for (const seg of segments) {
    const words = cleanSplitWords(seg.text);
    const kept: string[] = [];
    let capitalizeNext = false;
    for (const w of words) {
      if (isFiller(w)) {
        // "Um, so" at a sentence start becomes "So".
        if (/^\p{Lu}/u.test(w)) capitalizeNext = true;
        if (/[.!?]$/.test(w) && kept.length > 0) {
          const prev = kept[kept.length - 1] ?? '';
          if (!/[.!?,;:]$/.test(prev)) kept[kept.length - 1] = `${prev}${w.slice(-1)}`;
        }
        continue;
      }
      kept.push(capitalizeNext ? w.charAt(0).toUpperCase() + w.slice(1) : w);
      capitalizeNext = false;
    }
    if (kept.length === words.length) {
      out.push({ ...seg });
      continue;
    }
    const text = kept.join(' ');
    if (!text) {
      report.removed++;
      addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: '', rule: 'filler' });
      continue;
    }
    report.rewritten++;
    addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: text, rule: 'filler' });
    out.push({ ...seg, text });
  }
  return { segments: out, report };
}
