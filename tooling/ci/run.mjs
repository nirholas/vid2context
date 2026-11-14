#!/usr/bin/env node
/**
 * Local CI: runs every check the repo has, in order, timing each step, then
 * prints a summary table. Replaces the GitHub Actions workflow, which cannot
 * run on this account. Node only, no dependencies.
 *
 *   node tooling/ci/run.mjs                 stop at the first failure
 *   node tooling/ci/run.mjs --keep-going    run every step, report all failures
 *   node tooling/ci/run.mjs --only lint,test
 *   node tooling/ci/run.mjs --skip build
 *   node tooling/ci/run.mjs --list
 *
 * Exit code is 0 only when every step that ran passed. Step output streams
 * through; the table goes to stdout at the end, notes to stderr.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const bin = (name) => join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const scripts = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
const live = process.env.LIVE === '1' || process.env.LIVE === 'true';

/**
 * Each step: a command, and optionally `needs` (a root npm script that must
 * exist, else the step is reported as absent) and `when` (a condition).
 */
const STEPS = [
  { name: 'gen', cmd: [NPM, 'run', 'gen'], about: 'regenerate the provider registries' },
  { name: 'typecheck', cmd: [bin('tsc'), '-p', 'tsconfig.json'], about: 'tsc over every workspace' },
  { name: 'lint', cmd: [bin('biome'), 'check', '.'], about: 'Biome lint and format check' },
  { name: 'test', cmd: [bin('vitest'), 'run'], about: 'Vitest unit tests on recorded fixtures' },
  {
    name: 'tooling-test',
    cmd: [bin('vitest'), 'run', '--config', 'tooling/vitest.config.ts'],
    about: 'tests for this CI and the hygiene checks',
  },
  { name: 'conformance', cmd: [NPM, 'run', 'conformance'], needs: 'conformance', about: 'provider conformance suites' },
  { name: 'hygiene', cmd: [process.execPath, 'tooling/checks/run.mjs'], about: 'house-rule checks on tracked files' },
  { name: 'build', cmd: [NPM, 'run', 'build:npm'], needs: 'build:npm', about: 'bundle the publishable npm packages' },
  {
    name: 'eval',
    cmd: [NPM, 'run', 'eval', '--', '--check'],
    needs: 'eval',
    when: () => live,
    whenNote: 'LIVE=1 only',
    about: 'quality evals against live services',
  },
];

function parseArgs(argv) {
  const opts = { keepGoing: false, only: null, skip: new Set(), list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v.split(',').map((s) => s.trim());
    };
    if (a === '--keep-going' || a === '-k') opts.keepGoing = true;
    else if (a === '--list') opts.list = true;
    else if (a.startsWith('--only')) opts.only = new Set(value());
    else if (a.startsWith('--skip')) for (const s of value()) opts.skip.add(s);
    else throw new Error(`unknown option ${a}`);
  }
  const known = new Set(STEPS.map((s) => s.name));
  for (const n of [...(opts.only ?? []), ...opts.skip]) if (!known.has(n)) throw new Error(`unknown step ${n}`);
  return opts;
}

function formatTable(rows) {
  const head = ['step', 'status', 'seconds'];
  const body = rows.map((r) => [r.name, r.status, r.seconds === null ? '' : r.seconds.toFixed(1)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 2 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ci: ${err.message}`);
    return 2;
  }
  if (opts.list) {
    for (const s of STEPS) process.stdout.write(`${s.name.padEnd(13)} ${s.about}${s.whenNote ? ` (${s.whenNote})` : ''}\n`);
    return 0;
  }

  const available = scripts();
  const rows = [];
  let failed = false;
  const started = performance.now();
  for (const step of STEPS) {
    const row = { name: step.name, status: '', seconds: null };
    rows.push(row);
    if (opts.only && !opts.only.has(step.name)) row.status = 'not selected';
    else if (opts.skip.has(step.name)) row.status = 'skipped';
    else if (step.when && !step.when()) row.status = `skipped (${step.whenNote})`;
    else if (step.needs && !available[step.needs]) row.status = `absent (no "${step.needs}" script)`;
    else if (failed && !opts.keepGoing) row.status = 'not run';
    else {
      console.error(`\n== ci: ${step.name}: ${step.cmd.map((c) => c.replace(`${ROOT}/`, '')).join(' ')}`);
      const t0 = performance.now();
      const res = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: ROOT, stdio: 'inherit', env: process.env });
      row.seconds = (performance.now() - t0) / 1000;
      if (res.error) {
        console.error(`ci: ${step.name} could not start: ${res.error.message}`);
        row.status = 'FAIL';
      } else row.status = res.status === 0 ? 'pass' : res.signal ? `FAIL (${res.signal})` : `FAIL (exit ${res.status})`;
      if (row.status !== 'pass') failed = true;
    }
  }
  const total = (performance.now() - started) / 1000;
  process.stdout.write(`\n${formatTable(rows)}\n`);
  console.error(`ci: ${failed ? 'FAILED' : 'passed'} in ${total.toFixed(1)}s`);
  return failed ? 1 : 0;
}

process.exitCode = main();
