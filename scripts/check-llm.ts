/**
 * npm run check:llm [-- --json] [--only a,b] [--skip a,b] [--include-paid] [--timeout ms] [--concurrency n]
 *
 * Sends one tiny real request to every enabled LLM rung and prints which
 * answered, how fast, and whether the answer was right. Paid rungs are skipped
 * unless --include-paid is passed. --only and --skip take rung ids, services
 * ('groq', 'groq#2'), providers ('llm-free-catalog') or id prefixes
 * ('llm/kilo'). Exit code 1 when no rung answered. The table (or JSON) goes to
 * stdout; progress and logs go to stderr.
 */
import { CHECK_REQUEST, exitCodeFor, formatTable, runChecks, selectRungs } from '@vid2context/provider-llm-free-catalog';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';

interface Args {
  json: boolean;
  only: string[];
  skip: string[];
  includePaid: boolean;
  timeoutMs: number;
  concurrency: number;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, only: [], skip: [], includePaid: false, timeoutMs: 45_000, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === '--json') args.json = true;
    else if (flag === '--include-paid') args.includePaid = true;
    else if (flag === '--only') args.only.push(...list(value()));
    else if (flag === '--skip') args.skip.push(...list(value()));
    else if (flag === '--timeout') args.timeoutMs = Number(value()) || args.timeoutMs;
    else if (flag === '--concurrency') args.concurrency = Number(value()) || args.concurrency;
    else if (flag === '--help' || flag === '-h') {
      console.error(
        'usage: npm run check:llm -- [--json] [--only a,b] [--skip a,b] [--include-paid] [--timeout ms] [--concurrency n]',
      );
      process.exit(0);
    } else {
      console.error(`check:llm: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadEnvFiles();
  if (loaded.length > 0) console.error(`check:llm: loaded env from ${loaded.join(', ')}`);
  const env = process.env as Record<string, string | undefined>;
  const ctx = createNodeContext({ env });
  const rungs = createRegistry().llmRungs(env);
  const { run, skipped } = selectRungs(rungs, env, args);
  console.error(
    `check:llm: calling ${run.length} rungs (timeout ${args.timeoutMs} ms, ${args.concurrency} services at a time) with "${CHECK_REQUEST.messages[0]?.content}"`,
  );
  const rows = await runChecks(run, ctx, args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ rows, skipped }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTable(rows, skipped)}\n`);
  }
  process.exitCode = exitCodeFor(rows);
}

main().catch((err) => {
  console.error(`check:llm: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
