/**
 * LIVE=1 only: starts src/node.ts on a random port and asks it for a real
 * YouTube transcript, then checks graceful shutdown on SIGTERM.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..', '..', '..');
const port = 20000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}/api/v1`;

describe.skipIf(!process.env.LIVE)('node server (live)', () => {
  let child: ChildProcess | undefined;
  let stderr = '';

  afterAll(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  });

  it('serves a real YouTube transcript and openapi.json, then shuts down cleanly', async () => {
    child = spawn(join(repo, 'node_modules', '.bin', 'tsx'), [join(repo, 'packages', 'server', 'src', 'node.ts')], {
      cwd: repo,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', VID2CONTEXT_ACCESS_LOG: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    const until = Date.now() + 30_000;
    while (!stderr.includes('listening')) {
      if (Date.now() > until) throw new Error(`server did not start: ${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }

    const res = await fetch(`${base}/transcript?url=${encodeURIComponent('https://youtu.be/jNQXAC9IVRw')}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('elephants');

    const doc = await (await fetch(`${base}/openapi.json`)).json();
    expect(doc.openapi).toBe('3.1.0');
    expect(stderr).toMatch(/"msg":"request".*"path":"\/api\/v1\/transcript"/);

    const exited = new Promise<number | null>((resolve) => child?.on('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(stderr).toContain('stopped');
  }, 90_000);
});
