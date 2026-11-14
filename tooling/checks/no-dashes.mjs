/**
 * no-dashes: the house style bans the en-dash (U+2013) and em-dash (U+2014)
 * in every tracked text file. Code that must match them writes the escapes.
 */
import { cli, findAll, isMain } from './lib.mjs';

/**
 * Recorded third-party data must stay byte-exact, so dashes in it are the
 * original bytes, not our prose. The repo keeps every recorded response under
 * a `fixtures/` directory inside a `test/` or `tests/` directory (for example
 * `providers/youtube/test/fixtures/`, `packages/core/test/chunk/fixtures/`,
 * the shared `tests/fixtures/`), the directories Biome also skips. Their
 * README files are our own writing and are still checked.
 */
export const RECORDED_DATA = /(?:^|\/)tests?\/(?:[^/]+\/)*fixtures\//;

export function isRecordedData(path) {
  return RECORDED_DATA.test(path) && !/(?:^|\/)README\.md$/i.test(path);
}

const DASH = /[\u2013\u2014]/g;

export const name = 'no-dashes';
export const description = 'no en-dash or em-dash characters';

export function select(path) {
  return !isRecordedData(path);
}

export function check(_path, text) {
  return findAll(text, DASH).map((h) => ({
    line: h.line,
    column: h.column,
    message: `${h.match === '\u2013' ? 'en-dash (U+2013)' : 'em-dash (U+2014)'}: use a comma, colon, period or parentheses`,
  }));
}

if (isMain(import.meta.url)) process.exitCode = cli([{ name, description, select, check }]);
