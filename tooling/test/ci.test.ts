import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../checks/lib.mjs';

const ci = (...args: string[]) =>
  spawnSync(process.execPath, [join(ROOT, 'tooling/ci/run.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });

describe('npm run ci', () => {
  it('runs the hygiene step on the real repo and prints the summary table', () => {
    // The verdict depends on what other work is in the tree right now, so the
    // test checks that the runner reports it faithfully, whichever way it goes.
    const direct = spawnSync(process.execPath, [join(ROOT, 'tooling/checks/run.mjs')], { cwd: ROOT, encoding: 'utf8' });
    const res = ci('--only', 'hygiene');
    const out = res.stdout.trim().split('\n');
    const table = out.slice(out.findIndex((l) => /^step\s+status\s+seconds$/.test(l)));
    expect(table[0]).toMatch(/^step\s+status\s+seconds$/);
    expect(table[1]).toMatch(/^-+\s+-+\s+-+$/);
    expect(table.find((l) => l.startsWith('typecheck'))).toMatch(/not selected/);
    const row = table.find((l) => l.startsWith('hygiene'));
    if (direct.status === 0) {
      expect(res.status, res.stdout + res.stderr).toBe(0);
      expect(row).toMatch(/^hygiene\s+pass\s+\d+\.\d$/);
      expect(res.stderr).toMatch(/ci: passed in/);
    } else {
      expect(res.status).toBe(1);
      expect(row).toMatch(/^hygiene\s+FAIL \(exit 1\)\s+\d+\.\d$/);
      expect(res.stderr).toMatch(/ci: FAILED in/);
    }
  });

  it('lists every step in order', () => {
    const names = ci('--list')
      .stdout.trim()
      .split('\n')
      .map((l) => l.split(/\s+/)[0]);
    expect(names).toEqual([
      'gen',
      'typecheck',
      'lint',
      'test',
      'tooling-test',
      'conformance',
      'hygiene',
      'build',
      'smoke',
      'eval',
    ]);
  });

  it('skips the eval step unless LIVE=1', () => {
    const res = ci('--only', 'hygiene');
    expect(res.stdout).toMatch(/eval\s+not selected/);
    const all = ci('--only', 'eval');
    expect(all.stdout).toMatch(/eval\s+skipped \(LIVE=1 only\)|eval\s+absent/);
  });

  it('rejects unknown steps with exit 2', () => {
    const res = ci('--only', 'nope');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('unknown step nope');
  });
});
