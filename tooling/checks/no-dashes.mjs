/**
 * no-dashes: the house style bans the en-dash (U+2013) and em-dash (U+2014)
 * in every tracked text file. Code that must match them writes the escapes.
 */
import { cli, findAll, isMain } from './lib.mjs';

/**
 * Third-party recorded fixtures that must stay byte-exact, so their dashes
 * are the original data, not our prose. Add a path here only for such files.
 */
export const BYTE_EXACT = new Set([
  // Wikimedia Commons subtitle track, replayed byte for byte.
  'packages/core/test/chunk/fixtures/commons-ap11-final-approach.en.srt',
  // Recorded YouTube innertube player response.
  'providers/youtube/test/fixtures/player-age-restricted-HtVdAasjOgU.json',
]);

const DASH = /[\u2013\u2014]/g;

export const name = 'no-dashes';
export const description = 'no en-dash or em-dash characters';

export function select(path) {
  return !BYTE_EXACT.has(path);
}

export function check(_path, text) {
  return findAll(text, DASH).map((h) => ({
    line: h.line,
    column: h.column,
    message: `${h.match === '\u2013' ? 'en-dash (U+2013)' : 'em-dash (U+2014)'}: use a comma, colon, period or parentheses`,
  }));
}

if (isMain(import.meta.url)) process.exitCode = cli([{ name, description, select, check }]);
