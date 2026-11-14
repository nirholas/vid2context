/**
 * Shared plumbing for the hygiene checks: which files to scan (tracked or
 * staged), how to read them, a comment and string stripper for code checks,
 * and the report format. Node only, no dependencies.
 *
 * A check is a module exporting:
 *   name         short id, also the CLI name
 *   description  one line for the report
 *   select(path) true when the repo-relative path is in scope
 *   check(path, text) array of { line, column, message }
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Synthetic linter inputs: the committed sample violations the check tests
 * read. Every check skips them, or the repo could never pass its own checks.
 */
export const SAMPLE_DIR = 'tooling/test/fixtures/';

export const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Repo-relative paths: every tracked file, or only the staged ones (added, copied, modified, renamed). */
export function listFiles({ staged = false, root = ROOT } = {}) {
  const out = staged ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root) : git(['ls-files', '-z'], root);
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => !p.startsWith(SAMPLE_DIR));
}

/**
 * File contents as text, or null for binaries, symlinks and files deleted
 * from the worktree. Staged mode reads the index, which is what the commit
 * will contain, not the worktree.
 */
export function readText(path, { staged = false, root = ROOT } = {}) {
  let buf;
  if (staged) {
    try {
      buf = execFileSync('git', ['show', `:${path}`], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
    } catch {
      return null;
    }
  } else {
    const abs = join(root, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    buf = readFileSync(abs);
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

/** 1-based line and column of a string offset. */
export function position(text, index) {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) {
    line++;
    last = i;
  }
  return { line, column: index - last };
}

/** Every match of a global regex as { line, column, match }. */
export function findAll(text, regex) {
  const hits = [];
  for (const m of text.matchAll(regex)) hits.push({ ...position(text, m.index), match: m[0] });
  return hits;
}

const REGEX_PREFIX = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bdo|\belse|\bin|\bof|\bvoid|\byield|\bawait)\s*$/;

/**
 * Blanks comments (and, with `strings: true`, string and template literal
 * contents) in JavaScript or TypeScript source, keeping every newline and
 * offset so reported positions stay right. Template `${...}` expressions stay
 * as code. Regex literals are recognized by the token before the slash.
 */
export function stripCode(src, { strings = false } = {}) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Stack of brace depths for template literals we are inside the ${} of.
  const templates = [];
  let depth = 0;
  let i = 0;
  const n = src.length;

  const scanTemplate = () => {
    // i is just past a backtick or a closing } of an expression.
    const start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        if (strings) blank(start, i);
        i++;
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        if (strings) blank(start, i);
        i += 2;
        templates.push(depth);
        depth++;
        return;
      }
      i++;
    }
    if (strings) blank(start, n);
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      const start = ++i;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      if (strings) blank(start, i);
      i++;
    } else if (c === '`') {
      i++;
      scanTemplate();
    } else if (c === '/' && REGEX_PREFIX.test(src.slice(Math.max(0, i - 12), i))) {
      // Regex literal: skip to the closing slash, honoring classes and escapes.
      let inClass = false;
      i++;
      while (i < n && src[i] !== '\n') {
        const r = src[i];
        if (r === '\\') i += 2;
        else {
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) break;
          i++;
        }
      }
      i++;
    } else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      depth--;
      i++;
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop();
        scanTemplate();
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Runs checks over files and returns the findings, sorted by path. */
export function runChecks(checks, { staged = false, root = ROOT, files } = {}) {
  const paths = files ?? listFiles({ staged, root });
  const findings = [];
  for (const path of paths) {
    const active = checks.filter((c) => c.select(path));
    if (!active.length) continue;
    const text = readText(path, { staged, root });
    if (text === null) continue;
    for (const c of active) {
      for (const v of c.check(path, text)) findings.push({ check: c.name, path, ...v });
    }
  }
  return { scanned: paths.length, findings };
}

/** Top-level grouping used in reports: `providers/youtube`, `packages/core`, `docs`. */
export function groupOf(path) {
  const parts = path.split('/');
  if ((parts[0] === 'packages' || parts[0] === 'providers') && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts.length > 1 ? parts[0] : '.';
}

/**
 * Human report, grouped by directory so each owner sees their own findings.
 * At most `perFile` lines per file and check; the rest are counted.
 */
export function formatReport(findings, { perFile = 5 } = {}) {
  const groups = new Map();
  for (const f of findings) {
    const g = groupOf(f.path);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  const lines = [];
  for (const g of [...groups.keys()].sort()) {
    lines.push(`${g}/`);
    const shown = new Map();
    for (const f of groups.get(g)) {
      const key = `${f.path}\0${f.check}`;
      const count = (shown.get(key) ?? 0) + 1;
      shown.set(key, count);
      if (count <= perFile) lines.push(`  ${f.path}:${f.line}:${f.column}  [${f.check}] ${f.message}`);
    }
    for (const [key, count] of shown) {
      if (count <= perFile) continue;
      const [path, check] = key.split('\0');
      lines.push(`  ${path}  [${check}] ...and ${count - perFile} more`);
    }
  }
  return lines.join('\n');
}

/**
 * CLI shared by every check file and the combined runner:
 *   node <check>.mjs [--staged] [--json]
 * Findings go to stdout, the summary to stderr. Exit 1 on any finding.
 */
export function cli(checks, argv = process.argv.slice(2)) {
  const staged = argv.includes('--staged');
  const json = argv.includes('--json');
  const { scanned, findings } = runChecks(checks, { staged });
  if (json) process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  else if (findings.length) process.stdout.write(`${formatReport(findings)}\n`);
  const names = checks.map((c) => c.name).join(', ');
  console.error(
    `hygiene (${names}): ${findings.length ? `${findings.length} finding(s)` : 'clean'}, ${scanned} ${staged ? 'staged' : 'tracked'} file(s)`,
  );
  return findings.length ? 1 : 0;
}

/** True when the module at `url` is the script node was started with. */
export function isMain(url) {
  return process.argv[1] !== undefined && url === pathToFileURL(resolve(process.argv[1])).href;
}
