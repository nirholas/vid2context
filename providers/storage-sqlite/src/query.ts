/**
 * Turns free text a user typed into a safe FTS5 MATCH expression.
 *
 * Users may type plain words, "exact phrases" and trailing `*` prefixes.
 * Everything else FTS5 would treat as syntax (AND, OR, NOT, NEAR, parentheses,
 * column filters, `^`, `-`, stray or unbalanced quotes) is dropped or quoted,
 * so no input can produce an FTS syntax error. Terms are joined with OR: bm25
 * then ranks segments that contain more of the terms, and rarer terms, first.
 * Transcript segments are a few words long, so requiring every term in one
 * segment would miss most real matches.
 */

export interface SearchTerm {
  /** The word or phrase as typed, minus syntax. The FTS tokenizer folds case and diacritics. */
  text: string;
  /** True for a quoted phrase. */
  phrase: boolean;
  /** True when the user typed a trailing `*`. */
  prefix: boolean;
}

const OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);
const WORD = /[\p{L}\p{N}]/u;

/** Keeps letters, digits and inner punctuation the tokenizer splits on anyway; removes quotes. */
function clean(raw: string): string {
  return raw.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Splits user text into words, phrases and prefixes. Unbalanced quotes are ignored. */
export function parseSearch(input: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const text = input.normalize('NFC');
  const quotes = (text.match(/"/g) ?? []).length;
  // With an odd number of quotes the last one is unbalanced: treat it as a plain character.
  const lastQuote = quotes % 2 === 1 ? text.lastIndexOf('"') : -1;

  const pushWords = (chunk: string) => {
    for (const token of chunk.split(/\s+/)) {
      if (!token) continue;
      const prefix = /[\p{L}\p{N}]\*+$/u.test(token);
      const body = clean(token.replace(/\*/g, ' ').replace(/[()^:{}[\]]/g, ' '));
      for (const part of body.split(' ')) {
        if (!WORD.test(part)) continue;
        // Bare uppercase operators are FTS syntax, not search words.
        if (OPERATORS.has(part)) continue;
        // Trim edge punctuation: leading - or + (exclusion syntax in other engines), trailing commas.
        const word = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (!WORD.test(word)) continue;
        terms.push({ text: word, phrase: false, prefix: false });
      }
      const last = terms.at(-1);
      if (prefix && last && !last.phrase) last.prefix = true;
    }
  };

  let i = 0;
  let plain = '';
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"' && i !== lastQuote) {
      const end = text.indexOf('"', i + 1);
      // end is always found: quotes before lastQuote are balanced.
      pushWords(plain);
      plain = '';
      const inner = clean(text.slice(i + 1, end).replace(/\*/g, ' '));
      let next = end + 1;
      let prefix = false;
      while (text[next] === '*') {
        prefix = true;
        next++;
      }
      if (WORD.test(inner)) terms.push({ text: inner, phrase: true, prefix });
      i = next;
      continue;
    }
    plain += ch === '"' ? ' ' : ch;
    i++;
  }
  pushWords(plain);
  return terms;
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** An FTS5 MATCH expression for the terms, or null when nothing searchable is left. */
export function toMatchExpression(terms: SearchTerm[]): string | null {
  if (terms.length === 0) return null;
  return terms.map((t) => `${quote(t.text)}${t.prefix ? '*' : ''}`).join(' OR ');
}

/** Escapes LIKE wildcards for use with `ESCAPE '\'`. */
export function likePattern(term: SearchTerm): string {
  const escaped = term.text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}
