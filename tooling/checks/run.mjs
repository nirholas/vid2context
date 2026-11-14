/**
 * Runs every hygiene check, or the ones named on the command line.
 *   node tooling/checks/run.mjs [--staged] [--json] [check ...]
 * `--staged` scans only `git diff --cached` files, reading their staged
 * contents, which is what the pre-commit hook uses.
 */
import * as edgeSafe from './edge-safe.mjs';
import { cli } from './lib.mjs';
import * as noConsoleLog from './no-console-log.mjs';
import * as noDashes from './no-dashes.mjs';
import * as noProcessEnv from './no-process-env.mjs';
import * as noTodo from './no-todo.mjs';
import * as secrets from './secrets.mjs';

export const CHECKS = [noDashes, noTodo, secrets, edgeSafe, noProcessEnv, noConsoleLog];

const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith('--'));
const unknown = names.filter((n) => !CHECKS.some((c) => c.name === n));
if (unknown.length) {
  console.error(`unknown check(s): ${unknown.join(', ')}. Known: ${CHECKS.map((c) => c.name).join(', ')}`);
  process.exitCode = 2;
} else {
  const chosen = names.length ? CHECKS.filter((c) => names.includes(c.name)) : CHECKS;
  process.exitCode = cli(chosen, args);
}
