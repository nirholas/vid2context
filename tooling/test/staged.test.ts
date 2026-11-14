import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, runChecks } from '../checks/lib.mjs';
import * as noDashes from '../checks/no-dashes.mjs';

const EM = '—';

/** A throwaway git repo with this repo's tooling/ copied in, so hooks can run against it. */
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'v2c-hooks-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'hygiene-test');
  git('config', 'user.email', 'hygiene-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  for (const sub of ['checks', 'hooks']) cpSync(join(ROOT, 'tooling', sub), join(dir, 'tooling', sub), { recursive: true });
  return { dir, git };
}

describe('--staged', () => {
  it('scans only staged files and reads the staged contents, not the worktree', () => {
    const { dir, git } = tempRepo();
    writeFileSync(join(dir, 'clean.md'), 'clean\n');
    git('add', 'clean.md');
    git('commit', '-q', '-m', 'base', '--no-verify');

    writeFileSync(join(dir, 'notes.md'), `staged ${EM} dash\n`);
    git('add', 'notes.md');
    // Fixed in the worktree but not staged: the commit would still carry the dash.
    writeFileSync(join(dir, 'notes.md'), 'fixed\n');
    writeFileSync(join(dir, 'unstaged.md'), `untracked ${EM}\n`);

    const staged = runChecks([noDashes], { staged: true, root: dir });
    expect(staged.scanned).toBe(1);
    expect(staged.findings.map((f: { path: string; line: number }) => [f.path, f.line])).toEqual([['notes.md', 1]]);
  });
});

describe('hooks', () => {
  it('install points core.hooksPath at tooling/hooks, and pre-commit blocks a staged dash', () => {
    const { dir, git } = tempRepo();
    execFileSync(process.execPath, [join(dir, 'tooling/hooks/install.mjs')], { cwd: dir, stdio: 'pipe' });
    expect(git('config', 'core.hooksPath').trim()).toBe('tooling/hooks');

    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/a.md'), `bad ${EM} line\n`);
    git('add', 'docs/a.md');
    const blocked = spawnSync('git', ['commit', '-q', '-m', 'blocked'], { cwd: dir, encoding: 'utf8' });
    expect(blocked.status).not.toBe(0);
    // Git sends hook output to stderr.
    expect(blocked.stdout + blocked.stderr).toContain('docs/a.md:1:5');

    writeFileSync(join(dir, 'docs/a.md'), 'good line\n');
    git('add', 'docs/a.md');
    const ok = spawnSync('git', ['commit', '-q', '-m', 'ok'], { cwd: dir, encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);

    execFileSync(process.execPath, [join(dir, 'tooling/hooks/install.mjs'), '--uninstall'], { cwd: dir, stdio: 'pipe' });
    expect(spawnSync('git', ['config', 'core.hooksPath'], { cwd: dir }).status).toBe(1);
  });

  it('ships executable hook files', () => {
    for (const hook of ['pre-commit', 'pre-push']) {
      const { dir } = tempRepo();
      const path = join(dir, 'tooling/hooks', hook);
      chmodSync(path, 0o644);
      execFileSync(process.execPath, [join(dir, 'tooling/hooks/install.mjs')], { cwd: dir, stdio: 'pipe' });
      expect(execFileSync('stat', ['-c', '%a', path], { encoding: 'utf8' }).trim()).toBe('755');
    }
  });
});
