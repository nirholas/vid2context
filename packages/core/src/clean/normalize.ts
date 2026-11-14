/**
 * Text normalization for caption cues: decode HTML entities, collapse
 * whitespace, optionally straighten curly quotes, and keep or remove sound
 * tags such as [Music], [Applause], (inaudible) and the music note symbols.
 */
import { decodeEntities } from '../segments.ts';
import type { Segment } from '../types.ts';
import { addCleanExample, type CleanReport, emptyCleanReport } from './report.ts';

export interface NormalizeCaptionOptions {
  /** 'keep' (default) leaves sound tags in place; 'remove' deletes them and drops segments left empty. */
  tags?: 'keep' | 'remove';
  /** 'straight' turns curly quotes into ' and ". Default 'keep'. */
  quotes?: 'keep' | 'straight';
}

/** Square brackets in captions are almost always sound or speaker tags. */
const BRACKET_TAG = /\[[^[\]]{1,60}\]/g;
/** Parentheses can hold real speech, so only known sound words count as tags there. */
const PAREN_TAG =
  /\((?:inaudible|unintelligible|indistinct(?: [a-z]+)?|music|upbeat music|applause|laughter|laughs|laughing|chuckles|crosstalk|silence|cheering|cheers|sighs|coughs|static)\)/gi;
/** A cue that is only a parenthetical sound description, such as "(baaaaahhh!!)". */
const WHOLE_PAREN = /^\([^()]{1,60}\)$/;
const NOTES = /[♪♫]+/g;

function removeTags(text: string): string {
  if (WHOLE_PAREN.test(text)) return '';
  return text.replace(BRACKET_TAG, ' ').replace(PAREN_TAG, ' ').replace(NOTES, ' ');
}

export function normalizeCaptionText(
  segments: readonly Segment[],
  opts: NormalizeCaptionOptions = {},
): { segments: Segment[]; report: CleanReport } {
  const report = emptyCleanReport('normalize');
  const out: Segment[] = [];
  for (const seg of segments) {
    let text = decodeEntities(seg.text).replace(/\s+/g, ' ').trim();
    if (opts.quotes === 'straight') text = text.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
    let rule: 'normalize' | 'tag-removed' = 'normalize';
    if (opts.tags === 'remove') {
      const stripped = removeTags(text).replace(/\s+/g, ' ').trim();
      if (stripped !== text) rule = 'tag-removed';
      text = stripped;
    }
    if (!text) {
      report.removed++;
      addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: '', rule });
      continue;
    }
    if (text !== seg.text) {
      report.rewritten++;
      addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: text, rule });
    }
    out.push({ ...seg, text });
  }
  return { segments: out, report };
}
