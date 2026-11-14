/**
 * no-console-log: library code never writes to stdout with console.log,
 * because stdout carries program output and the MCP stdio protocol. Log
 * through ctx.log; entry points and scripts use console.error. Covers
 * `packages/<name>/src` and `providers/<name>/src`. Comments and strings are
 * ignored.
 */
import { CODE_EXT, cli, isMain, position, stripCode } from './lib.mjs';

const CONSOLE_LOG = /\bconsole\s*\.\s*(?:log|info|debug)\s*\(/g;

export const name = 'no-console-log';
export const description = 'no console.log in library code';

export function select(path) {
  return CODE_EXT.test(path) && /^(?:packages|providers)\/[^/]+\/src\//.test(path);
}

export function check(_path, text) {
  const code = stripCode(text, { strings: true });
  return [...code.matchAll(CONSOLE_LOG)].map((m) => ({
    ...position(code, m.index),
    message: `${m[0].replace(/\s/g, '').slice(0, -1)} writes to stdout: use ctx.log, or console.error in entry points`,
  }));
}

if (isMain(import.meta.url)) process.exitCode = cli([{ name, description, select, check }]);
