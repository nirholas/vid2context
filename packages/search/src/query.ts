/**
 * Query syntax:
 *
 *   timing chain              plain words, ranked by both keyword and vector search
 *   "Land Cruiser killer"     exact phrase: every hit must contain it (stemmed, case-insensitive)
 *   oil -cooler               excluded word: no hit may contain it
 *   -"oil cooler"             excluded phrase
 *
 * Filters (collection, videos, channel, dates, transcript origin) are not
 * part of the text; they come as structured fields on SearchRequest.
 */
import { containsSequence, indexTerms, phraseWords } from './tokenize.ts';

export interface ParsedQuery {
  /** The query as given. */
  raw: string;
  /** Text for ranking: words and phrases, exclusions removed. Sent to the embedding model as is. */
  text: string;
  /** Stemmed keyword terms (stop words removed, model codes also split into parts) from words and phrases. */
  terms: string[];
  /** Required phrases, as stemmed word sequences (stop words kept). */
  phrases: string[][];
  /** Excluded words and phrases, as stemmed word sequences. */
  excluded: string[][];
  /** The phrases and excluded parts as typed, for display. */
  display: { phrases: string[]; excluded: string[] };
}

const TOKEN = /(-?)"([^"]*)"|(-?)(\S+)/g;

export function parseQuery(raw: string): ParsedQuery {
  const keep: string[] = [];
  const phrases: string[][] = [];
  const excluded: string[][] = [];
  const display = { phrases: [] as string[], excluded: [] as string[] };
  // An unbalanced quote is treated as a literal character, not an open phrase.
  const balanced = (raw.match(/"/g)?.length ?? 0) % 2 === 0 ? raw : raw.replace(/"(?=[^"]*$)/, ' ');
  for (const m of balanced.matchAll(TOKEN)) {
    const [, negQ, quoted, negW, word] = m;
    if (quoted !== undefined) {
      const seq = phraseWords(quoted);
      if (seq.length === 0) continue;
      if (negQ) {
        excluded.push(seq);
        display.excluded.push(quoted.trim());
      } else {
        phrases.push(seq);
        display.phrases.push(quoted.trim());
        keep.push(quoted.trim());
      }
      continue;
    }
    if (word === undefined) continue;
    if (negW && word.length > 0) {
      const seq = phraseWords(word);
      if (seq.length > 0) {
        excluded.push(seq);
        display.excluded.push(word);
      }
      continue;
    }
    keep.push(word);
  }
  const text = keep.join(' ').trim();
  return { raw, text, terms: indexTerms(text), phrases, excluded, display };
}

/** Whether a chunk's stemmed word sequence satisfies the required phrases and exclusions. */
export function passesConstraints(q: ParsedQuery, wordsOfChunk: string[]): boolean {
  for (const p of q.phrases) if (!containsSequence(wordsOfChunk, p)) return false;
  for (const x of q.excluded) if (containsSequence(wordsOfChunk, x)) return false;
  return true;
}
