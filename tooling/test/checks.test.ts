import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as edgeSafe from '../checks/edge-safe.mjs';
import { ROOT, readText } from '../checks/lib.mjs';
import * as noConsoleLog from '../checks/no-console-log.mjs';
import * as noDashes from '../checks/no-dashes.mjs';
import * as noProcessEnv from '../checks/no-process-env.mjs';
import * as noTodo from '../checks/no-todo.mjs';
import * as secrets from '../checks/secrets.mjs';

const sample = (name: string) => readFileSync(join(ROOT, 'tooling/test/fixtures', name), 'utf8');
const real = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const lines = (findings: { line: number }[]) => findings.map((f) => f.line);

describe('no-dashes', () => {
  it('finds each en-dash and em-dash with its position', () => {
    const found = noDashes.check('x.md', sample('dashes.md'));
    expect(found.map((f: { line: number; column: number }) => [f.line, f.column])).toEqual([
      [4, 9],
      [5, 8],
    ]);
    expect(found[0].message).toContain('U+2013');
    expect(found[1].message).toContain('U+2014');
  });

  it('passes the house rules file, which is written without dashes', () => {
    expect(noDashes.check('AGENTS.md', real('AGENTS.md'))).toEqual([]);
  });

  it('skips recorded third-party data in fixtures directories, but checks their READMEs', () => {
    for (const path of [
      'packages/core/test/chunk/fixtures/commons-ap11-final-approach.en.srt',
      'providers/youtube/test/fixtures/player-age-restricted-HtVdAasjOgU.json',
    ]) {
      expect(/[\u2013\u2014]/.test(real(path)), path).toBe(true);
      expect(noDashes.select(path), path).toBe(false);
    }
    expect(noDashes.select('tests/fixtures/contexts/x.json')).toBe(false);
    expect(noDashes.select('providers/youtube/test/fixtures/README.md')).toBe(true);
    expect(noDashes.select('providers/youtube/src/fixtures.ts')).toBe(true);
    expect(noDashes.select('docs/ci.md')).toBe(true);
  });
});

describe('no-todo', () => {
  it('flags markers after comment openers or with a colon or parenthesis', () => {
    expect(lines(noTodo.check('x.ts', sample('todo.ts')))).toEqual([1, 2, 3, 4, 7]);
  });

  it('accepts prose that names the words, as the provider contract does', () => {
    const text = real('docs/contracts/providers.md');
    expect(text).toMatch(/no TODO stubs/);
    expect(noTodo.check('docs/contracts/providers.md', text)).toEqual([]);
  });

  it('skips the rule files and fixtures', () => {
    expect(noTodo.select('AGENTS.md')).toBe(false);
    expect(noTodo.select('docs/prompts/38-local-ci-cloud-build-release.md')).toBe(false);
    expect(noTodo.select('tooling/checks/no-todo.mjs')).toBe(false);
    expect(noTodo.select('providers/youtube/test/fixtures/README.md')).toBe(false);
    expect(noTodo.select('docs/ARCHITECTURE.md')).toBe(true);
  });
});

describe('secrets', () => {
  it('finds every key shape in the samples and nothing in the clean line', () => {
    const found = secrets.check('x.txt', sample('secrets.txt'), new Set());
    expect(lines(found)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(found.every((f: { message: string }) => !f.message.includes('NotAKey0000'))).toBe(true);
  });

  it('honors the allowlist by path and exact value', () => {
    const allowed = secrets.parseAllowlist('x.txt AKIAIOSFODNN7EXAMPLE   # AWS docs sample\n# comment\n');
    expect(lines(secrets.check('x.txt', sample('secrets.txt'), allowed))).not.toContain(8);
    expect(lines(secrets.check('y.txt', sample('secrets.txt'), allowed))).toContain(8);
  });

  it('keeps every allowlist entry live: the file exists and still contains the value', () => {
    const allowed = secrets.parseAllowlist(real(secrets.ALLOWLIST_FILE));
    expect(allowed.size).toBeGreaterThan(0);
    for (const entry of allowed) {
      const [path, value] = entry.split(' ');
      expect(real(path), entry).toContain(value);
    }
  });
});

describe('edge-safe', () => {
  it('flags node: and bare built-in imports, dynamic import, require and re-exports', () => {
    const found = edgeSafe.check('x.ts', sample('edge-unsafe.ts'));
    expect(lines(found)).toEqual([1, 2, 3, 7, 8]);
  });

  it('scopes core and providers declaring workers or browser, not Node-only providers', () => {
    const scope = edgeSafe.scope();
    expect(edgeSafe.select('packages/core/src/pipeline.ts', scope)).toBe(true);
    expect(edgeSafe.select('providers/youtube/src/index.ts', scope)).toBe(true);
    expect(edgeSafe.select('providers/ytdlp/src/binary.ts', scope)).toBe(false);
    expect(edgeSafe.select('packages/cli/src/bin.ts', scope)).toBe(false);
  });

  it('exempts the file a package maps only to its Node condition', () => {
    const pkg = JSON.parse(real('providers/stt-transformers/package.json'));
    expect(edgeSafe.nodeOnlyFiles(pkg.exports)).toEqual(new Set(['src/node.ts']));
    const scope = edgeSafe.scope();
    expect(edgeSafe.select('providers/stt-transformers/src/node.ts', scope)).toBe(false);
    expect(edgeSafe.select('providers/stt-transformers/src/browser.ts', scope)).toBe(true);
  });

  it('passes the real YouTube provider entry', () => {
    expect(edgeSafe.check('providers/youtube/src/index.ts', real('providers/youtube/src/index.ts'))).toEqual([]);
  });
});

describe('no-process-env', () => {
  it('flags process.env, bare fetch() and globalThis.fetch, not ctx use, comments, strings or a fetch handler', () => {
    expect(noProcessEnv.check('x.ts', sample('process-env.ts')).map((f: { message: string }) => f.message)).toEqual([
      'process.env: read settings from ctx.env',
      'global fetch(): use ctx.fetch',
      'global fetch: use ctx.fetch',
    ]);
  });

  it('allows createContext to bind the real fetch, and entry points to read process.env', () => {
    expect(noProcessEnv.check('packages/core/src/context.ts', real('packages/core/src/context.ts'))).toEqual([]);
    const setup = 'providers/ytdlp/src/setup.ts';
    expect(real(setup)).toMatch(/process\.env/);
    expect(noProcessEnv.check(setup, real(setup))).toEqual([]);
  });

  it('still flags the global fetch in an entry point', () => {
    const text = "const ctx = createContext({ env: process.env });\nawait fetch('https://example.org');\n";
    expect(noProcessEnv.check('providers/x/src/setup.ts', text).map((f: { line: number }) => f.line)).toEqual([2]);
  });
});

describe('no-console-log', () => {
  it('flags console.log and console.info, not console.error, comments or strings', () => {
    expect(lines(noConsoleLog.check('x.ts', sample('console-log.ts')))).toEqual([2, 3]);
  });

  it('covers library src, not scripts or tooling', () => {
    expect(noConsoleLog.select('packages/cli/src/bin.ts')).toBe(true);
    expect(noConsoleLog.select('providers/youtube/src/index.ts')).toBe(true);
    expect(noConsoleLog.select('scripts/gen-registry.mjs')).toBe(false);
    expect(noConsoleLog.select('tooling/ci/run.mjs')).toBe(false);
  });
});

describe('readText', () => {
  it('returns null for binary files', () => {
    expect(readText('tests/fixtures/media/apollo11-small-step.mp3')).toBeNull();
    expect(readText('package.json')).toContain('"workspaces"');
  });
});
