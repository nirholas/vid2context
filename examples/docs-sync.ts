/**
 * Keeps docs/examples/*.md in step with the scripts in examples/.
 *
 *   npm run examples:docs              rewrite the code and output blocks
 *   npm run examples:docs -- --check   list what is out of date, exit 1 if anything is
 *
 * A docs page marks a fenced block with a comment on the line before it:
 *
 *   <!-- example: examples/library/render-formats.ts -->   the file, verbatim
 *   <!-- output: examples/library/render-formats.ts -->    what the file prints
 *
 * Output blocks are allowed only for offline examples (their header says
 * "Offline:"). They are produced by running the example in an empty temp
 * directory with only PATH and HOME set, so the result does not depend on
 * your keys, your .env or your library. Live examples show recorded runs in
 * plain fences instead, and examples/test/ runs them under LIVE=1.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DOCS_DIR = join(ROOT, 'docs/examples');
const EXAMPLES_DIR = join(ROOT, 'examples');
const RUNNABLE = new Set(['.ts', '.sh', '.py']);
const NOT_EXAMPLES = new Set(['docs-sync.ts']);

export interface Example {
  /** Repo-relative path with forward slashes, as written in the docs markers. */
  path: string;
  /** The header comment, without comment markers. */
  header: string;
  /** Runs with no network and no keys; its output is checked against the docs. */
  offline: boolean;
  /** Talks to a running HTTP server (`npm run start:server`); takes the base URL as its first argument. */
  needsServer: boolean;
}

const toPosix = (p: string) => p.split(sep).join('/');

/** The leading comment of a script: a JSDoc block, a Python docstring or # lines after the shebang. */
export function headerOf(source: string, ext: string): string {
  if (ext === '.ts') {
    const m = source.match(/^\/\*\*([\s\S]*?)\*\//);
    return m?.[1] ? m[1].replace(/^[ \t]*\* ?/gm, '').trim() : '';
  }
  if (ext === '.py') {
    const m = source.match(/^"""([\s\S]*?)"""/);
    return m?.[1]?.trim() ?? '';
  }
  const lines = source.split('\n');
  const out: string[] = [];
  for (const line of lines.slice(lines[0]?.startsWith('#!') ? 1 : 0)) {
    if (!line.startsWith('#')) break;
    out.push(line.replace(/^# ?/, ''));
  }
  return out.join('\n').trim();
}

export function listExamples(): Example[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const abs = join(dir, e.name);
      if (e.isDirectory()) return e.name === 'test' || e.name === 'node_modules' || e.name.startsWith('.') ? [] : walk(abs);
      return RUNNABLE.has(extname(e.name)) && !NOT_EXAMPLES.has(e.name) && dir !== EXAMPLES_DIR ? [abs] : [];
    });
  return walk(EXAMPLES_DIR)
    .sort()
    .map((abs) => {
      const header = headerOf(readFileSync(abs, 'utf8'), extname(abs));
      return {
        path: toPosix(relative(ROOT, abs)),
        header,
        offline: /^Offline:/m.test(header),
        needsServer: header.includes('npm run start:server'),
      };
    });
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The interpreter for a script, from the repo's own toolchain where there is one. */
export function commandFor(path: string): { command: string; args: string[] } {
  const abs = join(ROOT, path);
  const ext = extname(path);
  if (ext === '.ts') return { command: join(ROOT, 'node_modules/.bin/tsx'), args: [abs] };
  if (ext === '.sh') return { command: 'bash', args: [abs] };
  const venv = join(ROOT, 'clients/python/.venv/bin/python');
  return { command: existsSync(venv) ? venv : 'python3', args: [abs] };
}

/** Run one example and collect its output. Default: a fresh temp directory and only PATH and HOME. */
export function runExample(
  path: string,
  opts: { args?: string[]; env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const { command, args } = commandFor(path);
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'vid2context-example-'));
  const env = opts.env ?? { PATH: process.env.PATH, HOME: process.env.HOME };
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args, ...(opts.args ?? [])], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 120_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!opts.cwd) rmSync(cwd, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

export interface Block {
  doc: string;
  kind: 'example' | 'output';
  path: string;
  lang: string;
  content: string;
  /** Offsets of the block body (with its closing newline) inside the doc, for rewriting. */
  start: number;
  end: number;
}

// Groups: kind, path, fence (3 or more backticks, so output holding a fence still works), lang, body, body newline.
const MARKER = /<!-- (example|output): (\S+) -->\n+(`{3,})([\w-]*)\n([\s\S]*?)(\n?)^\3$/gm;

export function docPages(): string[] {
  if (!existsSync(DOCS_DIR)) return [];
  return readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => join(DOCS_DIR, f));
}

export function blocksOf(doc: string): Block[] {
  const text = readFileSync(doc, 'utf8');
  return [...text.matchAll(MARKER)].map((m) => {
    const [whole, kind = '', path = '', fence = '', lang = '', body = '', newline = ''] = m;
    const bodyStart = (m.index ?? 0) + whole.indexOf('\n', whole.indexOf(fence)) + 1;
    return {
      doc: toPosix(relative(ROOT, doc)),
      kind: kind as Block['kind'],
      path,
      lang,
      content: body,
      start: bodyStart,
      end: bodyStart + body.length + newline.length,
    };
  });
}

const LANG: Record<string, string> = { '.ts': 'ts', '.sh': 'bash', '.py': 'python' };

/** What a block should contain. Output blocks run the example, so this is async. */
export async function expectedBody(block: Block, examples: Map<string, Example>): Promise<string> {
  const ex = examples.get(block.path);
  if (!ex) throw new Error(`${block.doc}: ${block.kind} marker names ${block.path}, which is not an example file.`);
  if (block.kind === 'example') {
    const want = LANG[extname(block.path)] ?? '';
    if (block.lang !== want) throw new Error(`${block.doc}: the block for ${block.path} must be fenced as \`\`\`${want}.`);
    return readFileSync(join(ROOT, block.path), 'utf8').replace(/\n$/, '');
  }
  if (!ex.offline)
    throw new Error(`${block.doc}: ${block.path} is a live example; show a recorded run in a plain fence instead.`);
  const run = await runExample(block.path);
  if (run.code !== 0) throw new Error(`${block.path} exited with ${run.code}:\n${run.stderr}`);
  return run.stdout.replace(/\n$/, '');
}

export interface Drift {
  doc: string;
  kind: Block['kind'];
  path: string;
}

/** Compare every marked block with its file or its output; rewrite the docs unless `check`. */
export async function syncDocs(opts: { check: boolean }): Promise<Drift[]> {
  const examples = new Map(listExamples().map((e) => [e.path, e]));
  const outputs = new Map<string, Promise<string>>();
  const drift: Drift[] = [];
  for (const doc of docPages()) {
    const blocks = blocksOf(doc);
    let text = readFileSync(doc, 'utf8');
    // Rewrite from the end so earlier offsets stay valid.
    for (const block of [...blocks].reverse()) {
      const key = `${block.kind}:${block.path}`;
      if (!outputs.has(key)) outputs.set(key, expectedBody(block, examples));
      const body = await (outputs.get(key) as Promise<string>);
      if (body === block.content) continue;
      drift.push({ doc: block.doc, kind: block.kind, path: block.path });
      text = `${text.slice(0, block.start)}${body}\n${text.slice(block.end)}`;
    }
    if (!opts.check && drift.some((d) => d.doc === toPosix(relative(ROOT, doc)))) writeFileSync(doc, text);
  }
  return drift.reverse();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const drift = await syncDocs({ check });
  for (const d of drift) console.error(`${check ? 'out of date' : 'updated'}: ${d.doc} (${d.kind} of ${d.path})`);
  if (drift.length === 0) console.error('docs/examples is up to date.');
  else if (check) {
    console.error('Run `npm run examples:docs` to rewrite these blocks.');
    process.exitCode = 1;
  }
}
