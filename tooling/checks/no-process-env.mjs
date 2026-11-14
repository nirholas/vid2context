/**
 * no-process-env: providers and core read settings from `ctx.env` and make
 * requests with `ctx.fetch`, never `process.env` or the global `fetch`, so
 * they work on every runtime and tests can replay recorded responses.
 * Comments and strings are ignored. Call `ctx.fetch(...)` directly: a
 * destructured `const { fetch } = ctx` reads like the global and is flagged.
 *
 * Entry points (files that call `createContext(...)`, such as a provider's
 * setup script) build ctx.env from process.env, so process.env is allowed
 * there. The global fetch is not.
 */
import { CODE_EXT, cli, isMain, position, stripCode } from './lib.mjs';

const RULES = [
  [/\bprocess\s*\.\s*env\b/g, 'process.env: read settings from ctx.env'],
  [/\bprocess\s*\[\s*['"]env['"]\s*\]/g, 'process["env"]: read settings from ctx.env'],
  [/\b(?:globalThis|window|self|global)\s*\.\s*fetch\b/g, 'global fetch: use ctx.fetch'],
  // A bare call, not a method (`x.fetch(`), a definition (`async fetch(`, `function fetch(`) or a declaration.
  [/(?<![.\w$])(?<!\b(?:async|function)\s+)fetch\s*\(/g, 'global fetch(): use ctx.fetch'],
];

/**
 * The one place allowed to touch a global: createContext binds the real
 * fetch into ctx.fetch when the caller passes none.
 */
export const EXEMPT = new Map([['packages/core/src/context.ts', new Set(['global fetch: use ctx.fetch'])]]);

const ENTRY_POINT = /(?<!function\s+)\bcreateContext\s*\(/;

const METHOD_DEF = /^\s*fetch\s*\([^)]*\)\s*(?::[^{]+)?\{/;

export const name = 'no-process-env';
export const description = 'no process.env or global fetch in providers and core';

export function select(path) {
  return CODE_EXT.test(path) && (/^providers\/[^/]+\/src\//.test(path) || path.startsWith('packages/core/src/'));
}

export function check(path, text) {
  const exempt = EXEMPT.get(path);
  const code = stripCode(text, { strings: true });
  const lines = code.split('\n');
  const out = [];
  for (const [regex, message] of RULES) {
    if (exempt?.has(message)) continue;
    if (message.startsWith('process') && ENTRY_POINT.test(code)) continue;
    for (const m of code.matchAll(regex)) {
      const at = position(code, m.index);
      if (message.startsWith('global fetch()') && METHOD_DEF.test(lines[at.line - 1].slice(at.column - 1))) continue;
      out.push({ line: at.line, column: at.column, message });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

if (isMain(import.meta.url)) process.exitCode = cli([{ name, description, select, check }]);
