/**
 * Keeps the examples runnable and the docs that show them true.
 *
 * Always: every example has a header that says how to run it and whether it
 * is offline or live, every example is shown on a page in docs/examples/,
 * every code block there matches its file, and every offline example runs
 * (no keys, an empty temp directory) and prints exactly the output on its page.
 *
 * LIVE=1: every live example runs against the real services with your
 * environment, and the ones that need the HTTP API get a server started on a
 * free port for the run.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blocksOf, commandFor, docPages, type Example, expectedBody, listExamples, ROOT, runExample } from '../docs-sync.ts';

const examples = listExamples();
const byPath = new Map(examples.map((e) => [e.path, e]));
const blocks = docPages().flatMap(blocksOf);
const SYNC_HINT = 'Run `npm run examples:docs` to rewrite the blocks in docs/examples/, then review the diff.';

describe('examples', () => {
  it('finds the examples and the docs pages', () => {
    expect(examples.length).toBeGreaterThan(10);
    expect(blocks.length).toBeGreaterThan(examples.length);
  });

  describe.each(examples)('$path', (ex: Example) => {
    it('has a header with the command that runs it and says offline or live', () => {
      const runner = { '.ts': 'npx tsx', '.sh': 'bash', '.py': 'python' }[extname(ex.path)];
      expect(ex.header, 'the run command').toContain(`${runner} ${ex.path}`);
      expect(/^(Offline:|Live,)/m.test(ex.header), 'a line starting with "Offline:" or "Live,"').toBe(true);
    });

    it('is shown on a docs page, verbatim', () => {
      const shown = blocks.filter((b) => b.kind === 'example' && b.path === ex.path);
      expect(shown.length, `no <!-- example: ${ex.path} --> block in docs/examples/`).toBeGreaterThan(0);
      const file = readFileSync(join(ROOT, ex.path), 'utf8').replace(/\n$/, '');
      for (const b of shown) expect(b.content, `${b.doc} shows an old copy of ${ex.path}. ${SYNC_HINT}`).toBe(file);
    });

    it.runIf(ex.offline)('runs offline and prints the output shown in the docs', async () => {
      const shown = blocks.filter((b) => b.kind === 'output' && b.path === ex.path);
      expect(shown.length, `offline examples need an <!-- output: ${ex.path} --> block`).toBeGreaterThan(0);
      const [first] = shown;
      if (!first) return;
      const actual = await expectedBody(first, byPath);
      for (const b of shown) expect(b.content, `${b.doc} shows output ${ex.path} no longer prints. ${SYNC_HINT}`).toBe(actual);
    });
  });

  it('every marker names an example file', () => {
    const unknown = blocks.filter((b) => !byPath.has(b.path)).map((b) => `${b.doc}: ${b.path}`);
    expect(unknown).toEqual([]);
  });

  it('shows output blocks only for offline examples', () => {
    const live = blocks.filter((b) => b.kind === 'output' && !byPath.get(b.path)?.offline).map((b) => `${b.doc}: ${b.path}`);
    expect(live).toEqual([]);
  });

  it('keeps the docs free of the dash characters the house style forbids', () => {
    for (const doc of docPages()) expect(readFileSync(doc, 'utf8'), doc).not.toMatch(/[\u2013\u2014]/);
  });
});

// ------------------------------------------------------------------ live

const LIVE_TIMEOUT = 600_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

const has = (command: string, args: string[]) => spawnSync(command, args, { stdio: 'ignore' }).status === 0;

/** Python examples need the client and, for the loaders, their framework installed. */
function pythonReady(path: string): boolean {
  const { command } = commandFor(path);
  const modules = ['vid2context', 'httpx'];
  if (path.includes('langchain')) modules.push('langchain_core');
  if (path.includes('llama_index')) modules.push('llama_index.core');
  return has(command, ['-c', modules.map((m) => `import ${m}`).join('; ')]);
}

describe.skipIf(!process.env.LIVE)('live examples', () => {
  let server: ChildProcess | undefined;
  let baseUrl = '';
  const serverDir = mkdtempSync(join(tmpdir(), 'vid2context-examples-server-'));

  beforeAll(async () => {
    if (!examples.some((e) => e.needsServer)) return;
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'packages/server/src/node.ts')], {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', VID2CONTEXT_ACCESS_LOG: '0' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ok = await fetch(`${baseUrl}/api/v1/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`The HTTP API did not answer on ${baseUrl} within 60 seconds.`);
  }, 90_000);

  afterAll(() => {
    server?.kill('SIGTERM');
    rmSync(serverDir, { recursive: true, force: true });
  });

  it.for(examples.filter((e) => !e.offline))(
    '$path runs against the real services',
    { timeout: LIVE_TIMEOUT },
    async (ex, ctx) => {
      if (extname(ex.path) === '.py' && !pythonReady(ex.path)) {
        ctx.skip(`Python with the vid2context client is not installed for ${ex.path}; see clients/python/README.md.`);
      }
      if (/\bjq\b/.test(ex.header) && !has('jq', ['--version'])) ctx.skip(`${ex.path} needs jq.`);
      const run = await runExample(ex.path, {
        args: ex.needsServer ? [baseUrl] : [],
        env: { ...process.env },
        timeoutMs: LIVE_TIMEOUT - 10_000,
      });
      expect(run.code, `${ex.path} failed:\n${run.stderr.slice(-4000)}`).toBe(0);
      expect(run.stdout.trim().length).toBeGreaterThan(0);
    },
  );
});
