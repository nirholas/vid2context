/**
 * `npm run eval`: run evaluation suites against real videos and real rungs,
 * write a dated JSON result plus a Markdown report per suite, and optionally
 * enforce regression thresholds.
 *
 * stdout carries the report (or JSON with --json); progress, warnings and
 * errors go to stderr.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Ctx, type Env, keylessAllowed, type Registry, Vid2ContextError } from '@vid2context/core';
import { type EvalArgs, parseArgs, USAGE } from './args.ts';
import { evalsCacheDir } from './cache.ts';
import { checkThresholds, loadThresholds } from './check.ts';
import { REFS_DIR } from './refs.ts';
import { renderReport } from './report.ts';
import { type EvalResult, type SuiteName, summarize } from './results.ts';
import { runCaptionsSuite } from './suites/captions.ts';
import { runCitationsSuite } from './suites/citations.ts';
import type { SuiteContext } from './suites/common.ts';
import { runSearchSuite } from './suites/search.ts';
import { runSttSuite, type SuiteOutput } from './suites/stt.ts';

export const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));

export interface RunDeps {
  env: Env;
  /** Created only after the live check passes, so a refused run touches nothing. */
  setup(): Promise<{ registry: Registry; ctx: Ctx; envFiles: number }>;
  stdout(s: string): void;
  stderr(s: string): void;
  cwd?: string;
  now?(): Date;
}

/** Suites that need packages which have not landed in this repo yet, and what they need. Empty when every suite can run. */
export const UNAVAILABLE: Partial<Record<SuiteName, string>> = {};

export function liveAllowed(env: Env, args: Pick<EvalArgs, 'live'>): boolean {
  return args.live || env.LIVE === '1' || env.LIVE === 'true';
}

async function runSuite(suite: SuiteName, sc: SuiteContext): Promise<SuiteOutput> {
  if (suite === 'stt') return runSttSuite(sc);
  if (suite === 'captions') return runCaptionsSuite(sc, false);
  if (suite === 'cleanup') return runCaptionsSuite(sc, true);
  if (suite === 'citations') return runCitationsSuite(sc);
  return runSearchSuite(sc);
}

/** Run the CLI. Returns the process exit code: 0 ok, 1 threshold breach, 2 usage or setup error. */
export async function main(argv: readonly string[], deps: RunDeps): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    const e = err as Vid2ContextError;
    deps.stderr(`${e.message}\n${e.hint ?? ''}\n`);
    return 2;
  }
  if (args.help) {
    deps.stdout(USAGE);
    return 0;
  }
  if (!liveAllowed(deps.env, args)) {
    deps.stderr(
      'vid2context eval runs real rungs against real videos, so it needs the network and may use your free quotas.\n' +
        'Nothing was evaluated. Start it with LIVE=1 (LIVE=1 npm run eval -- --suite stt) or pass --live.\n' +
        'The metric code itself is unit-tested offline: npx vitest run packages/evals\n',
    );
    return 2;
  }

  const explicit = args.suites.length === 1;
  const suites = args.suites.filter((s) => {
    if (!UNAVAILABLE[s]) return true;
    deps.stderr(`Skipping the ${s} suite: it ${UNAVAILABLE[s]}.\n`);
    return false;
  });
  if (suites.length === 0) return explicit ? 2 : 0;

  const { registry, ctx, envFiles } = await deps.setup();
  const cwd = deps.cwd ?? process.cwd();
  const sc: SuiteContext = {
    registry,
    ctx,
    cacheDir: evalsCacheDir(deps.env, cwd),
    refsDir: REFS_DIR,
    record: args.record,
    limit: args.limit,
    rungs: args.rungs,
    dataset: args.dataset ? resolve(cwd, args.dataset) : undefined,
  };
  const outDir = args.out ? resolve(cwd, args.out) : RESULTS_DIR;
  const thresholds = args.check ? loadThresholds() : undefined;
  let breaches = 0;
  const jsonOut: EvalResult[] = [];

  for (const suite of suites) {
    const started = deps.now?.() ?? new Date();
    deps.stderr(`Running the ${suite} suite...\n`);
    let out: SuiteOutput;
    try {
      out = await runSuite(suite, sc);
    } catch (err) {
      const e = err instanceof Vid2ContextError ? err : new Vid2ContextError('upstream', (err as Error).message);
      deps.stderr(`The ${suite} suite failed: ${e.message}\n${e.hint ?? ''}\n`);
      return 2;
    }
    const finished = deps.now?.() ?? new Date();
    const result: EvalResult = {
      suite,
      date: started.toISOString().slice(0, 10),
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      dataset: out.dataset,
      environment: {
        node: process.versions.node,
        platform: `${process.platform}-${process.arch}`,
        policy: deps.env.VID2CONTEXT_POLICY || 'free',
        keyless: keylessAllowed(deps.env),
        rungs: out.rungs,
        envFiles,
      },
      skippedRungs: out.skippedRungs,
      notes: out.notes,
      items: out.items,
    };
    mkdirSync(outDir, { recursive: true });
    const base = join(outDir, `${result.date}-${suite}`);
    const report = renderReport(result);
    writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(`${base}.md`, report);
    deps.stderr(`Wrote ${relative(cwd, `${base}.json`)} and ${relative(cwd, `${base}.md`)}\n`);
    for (const s of result.skippedRungs) {
      deps.stderr(`Skipped ${s.rung}: ${s.reason}${s.envVars?.length ? ` (set ${s.envVars.join(', ')})` : ''}\n`);
    }
    if (args.json) jsonOut.push(result);
    else deps.stdout(report);
    if (thresholds) {
      for (const v of checkThresholds(suite, summarize(result.items), thresholds)) {
        breaches++;
        deps.stderr(`Regression: ${v.suite} ${v.rung} ${v.metric} is ${v.actual.toFixed(4)}, limit ${v.limit}\n`);
      }
    }
  }
  if (args.json) deps.stdout(`${JSON.stringify(jsonOut.length === 1 ? jsonOut[0] : jsonOut, null, 2)}\n`);
  return breaches > 0 ? 1 : 0;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const env = process.env as Env;
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.exitCode = await main(process.argv.slice(2), {
    env,
    async setup() {
      const { createNodeContext, createRegistry, loadEnvFiles } = await import('@vid2context/registry/node');
      const envFiles = loadEnvFiles().length;
      return { registry: createRegistry(), ctx: createNodeContext({ env: process.env as Env, signal: abort.signal }), envFiles };
    },
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
}
