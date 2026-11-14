/**
 * Points git at tooling/hooks (pre-commit: staged hygiene, pre-push: npm run ci).
 *   node tooling/hooks/install.mjs              enable
 *   node tooling/hooks/install.mjs --uninstall  back to .git/hooks
 * Changes only this clone's local git config (core.hooksPath).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

if (process.argv.includes('--uninstall')) {
  try {
    git('config', '--unset', 'core.hooksPath');
  } catch {
    // Exit status 5: the key was not set, which is the goal anyway.
  }
  console.error('hooks: disabled (core.hooksPath unset)');
} else {
  for (const hook of ['pre-commit', 'pre-push']) chmodSync(join(ROOT, 'tooling/hooks', hook), 0o755);
  git('config', 'core.hooksPath', 'tooling/hooks');
  console.error('hooks: enabled (core.hooksPath = tooling/hooks): pre-commit runs staged hygiene, pre-push runs npm run ci');
}
