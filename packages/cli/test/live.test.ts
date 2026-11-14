/**
 * Live subprocess tests: run the real binary against real YouTube and check
 * that stdout carries only program output while logs and notes go to stderr.
 * Gated by LIVE=1 (npm run test:live).
 */
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers.ts';

// The same as `npx tsx packages/cli/src/bin.ts`, without npx in between, so signals reach the CLI.
const BIN = join(ROOT, 'packages/cli/src/bin.ts');

function bin(...args: string[]) {
  const res = spawnSync(process.execPath, ['--import', 'tsx', BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe.skipIf(!process.env.LIVE)('live: the real binary', () => {
  it('get prints only the transcript on stdout', () => {
    const res = bin('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(res.code).toBe(0);
    expect(res.stdout.toLowerCase()).toContain('elephants');
    expect(res.stdout).not.toContain('[vid2context]');
    expect(res.stdout).not.toContain('Attempts:');
    expect(res.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('list prints one URL per line and the count on stderr', () => {
    const res = bin('list', 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b', '--limit', '3');
    expect(res.code).toBe(0);
    const lines = res.stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/);
    expect(res.stderr).toContain('3 items');
  });

  it('doctor --json prints every check as JSON on stdout', () => {
    const res = bin('doctor', '--json');
    expect([0, 1]).toContain(res.code);
    const checks = JSON.parse(res.stdout) as { id: string; status: string }[];
    expect(checks.map((c) => c.id)).toEqual([
      'node',
      'ffmpeg',
      'ffprobe',
      'yt-dlp',
      'deno',
      'gpu',
      'data-dir',
      'keys',
      'keyless',
      'youtube',
    ]);
    for (const c of checks) expect(['ok', 'warn', 'fail']).toContain(c.status);
  });

  it('serve answers the health route and stops on SIGTERM', async () => {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const child = spawn(process.execPath, ['--import', 'tsx', BIN, 'serve', '--port', String(port)], { cwd: ROOT });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    try {
      const deadline = Date.now() + 60_000;
      while (!stderr.includes('listening') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      expect(stderr).toContain(`http://127.0.0.1:${port}/api/v1/health`);
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      expect(res.status).toBe(200);
    } finally {
      child.kill('SIGTERM');
    }
  }, 90_000);
});
