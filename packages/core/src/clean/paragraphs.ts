/**
 * Paragraphs for formatters and the pack: a new paragraph starts after a
 * pause of 1.5 s or more, or once a paragraph reaches about 120 words (at the
 * next sentence end, or at 1.5 times the target if no sentence ends).
 */
import type { Segment } from '../types.ts';
import { cleanSplitWords } from './report.ts';

export interface CleanParagraph {
  startSec: number;
  endSec: number;
  text: string;
}

export interface GroupParagraphsOptions {
  /** Pause, in seconds, that starts a new paragraph. Default 1.5. */
  pauseSec?: number;
  /** Target paragraph length in words. Default 120. */
  targetWords?: number;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;

export function groupParagraphs(segments: readonly Segment[], opts: GroupParagraphsOptions = {}): CleanParagraph[] {
  const pause = opts.pauseSec ?? 1.5;
  const target = opts.targetWords ?? 120;
  const hardMax = Math.round(target * 1.5);
  const groups: { startSec: number; endSec: number; parts: string[]; words: number }[] = [];
  for (const seg of segments) {
    const text = seg.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const cur = groups[groups.length - 1];
    const last = cur?.parts[cur.parts.length - 1] ?? '';
    const startNew =
      !cur ||
      seg.startSec - cur.endSec >= pause ||
      (cur.words >= target && SENTENCE_END.test(last)) ||
      cur.words >= hardMax;
    const g = startNew || !cur ? { startSec: seg.startSec, endSec: seg.endSec, parts: [], words: 0 } : cur;
    if (g !== cur) groups.push(g);
    g.parts.push(text);
    g.words += cleanSplitWords(text).length;
    g.endSec = Math.max(g.endSec, seg.endSec);
  }
  return groups.map((g) => ({ startSec: g.startSec, endSec: g.endSec, text: g.parts.join(' ') }));
}
