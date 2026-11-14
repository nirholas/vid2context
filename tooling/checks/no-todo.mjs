/**
 * no-todo: no to-do markers in source or docs. Matches markers, not every
 * use of the word: a TODO, FIXME or XXX right after a comment opener, or
 * followed by a colon or parenthesis. Prose such as "no TODOs" passes.
 */
import { cli, findAll, isMain } from './lib.mjs';

/** Files that state the rule itself, so they name the words on purpose. */
export const RULE_FILES = new Set(['AGENTS.md', 'tooling/checks/no-todo.mjs']);
const RULE_DIRS = ['docs/prompts/'];

const WORD = '(?:TODO|FIXME|XXX)';
const AFTER_COMMENT = new RegExp(`(?:\\/\\/|\\/\\*|<!--|(?:^|\\s)#|^\\s*\\*|(?:^|\\s)--)\\s*${WORD}\\b`, 'gm');
const WITH_PUNCT = new RegExp(`\\b${WORD}\\b\\s*[:(]`, 'g');

export const name = 'no-todo';
export const description = 'no TODO, FIXME or XXX markers';

export function select(path) {
  if (RULE_FILES.has(path) || RULE_DIRS.some((d) => path.startsWith(d))) return false;
  return !/(?:^|\/)fixtures\//.test(path);
}

export function check(_path, text) {
  const seen = new Set();
  const out = [];
  for (const h of [...findAll(text, AFTER_COMMENT), ...findAll(text, WITH_PUNCT)]) {
    if (seen.has(h.line)) continue;
    seen.add(h.line);
    const word = h.match.match(/TODO|FIXME|XXX/)?.[0];
    out.push({ line: h.line, column: h.column, message: `${word} marker: finish the work or leave it out and say so` });
  }
  return out.sort((a, b) => a.line - b.line);
}

if (isMain(import.meta.url)) process.exitCode = cli([{ name, description, select, check }]);
