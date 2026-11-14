/** Command-line flags for `npm run eval`. */
import { Vid2ContextError } from '@vid2context/core';
import type { SuiteName } from './results.ts';

export const SUITES: SuiteName[] = ['stt', 'captions', 'cleanup', 'citations', 'search'];

export interface EvalArgs {
  suites: SuiteName[];
  rungs?: string[];
  limit?: number;
  /** Directory for result JSON and Markdown. Default packages/evals/results. */
  out?: string;
  /** Print the result JSON to stdout instead of the Markdown report. */
  json: boolean;
  live: boolean;
  /** Exit nonzero when a rung breaks packages/evals/thresholds.json. */
  check: boolean;
  /** Save fetched creator-caption references into datasets/refs instead of the cache. */
  record: boolean;
  /** A dataset file to use instead of the suite's default. */
  dataset?: string;
  help: boolean;
}

export const USAGE = `Usage: npm run eval -- --suite <stt|captions|cleanup|citations|search|all> [options]

Runs a real evaluation against real public videos and real rungs. Needs the
network, so it only starts with LIVE=1 in the environment or --live.

Options:
  --suite <name>     suite to run, or "all" (default: stt)
  --rungs <ids>      comma-separated rung ids, services or providers to score,
                     each pinned on its own; paid rungs run only when named here
  --limit <n>        evaluate only the first n dataset items
  --dataset <file>   use this dataset file instead of the suite's default
                     (a name in packages/evals/datasets/ or a path)
  --out <dir>        where to write <date>-<suite>.json and .md
                     (default: packages/evals/results)
  --json             print the result JSON instead of the Markdown report
  --check            exit 1 when a rung breaks packages/evals/thresholds.json
  --record           save fetched creator captions into datasets/refs/
  --live             same as LIVE=1
  --help             show this help
`;

function bad(message: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint: 'Run `npm run eval -- --help` for the flags.' });
}

export function parseArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = { suites: ['stt'], json: false, live: false, check: false, record: false, help: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw bad(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const [flag, inline] = a.includes('=') ? (a.split(/=(.*)/s, 2) as [string, string]) : [a, undefined];
    const take = (): string => {
      if (inline !== undefined) return inline;
      const v = value(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case '--suite': {
        const s = take();
        if (s === 'all') args.suites = [...SUITES];
        else if ((SUITES as string[]).includes(s)) args.suites = [s as SuiteName];
        else throw bad(`Unknown suite "${s}". Choose one of ${SUITES.join(', ')} or all.`);
        break;
      }
      case '--rungs':
        args.rungs = take()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--limit': {
        const n = Number(take());
        if (!Number.isInteger(n) || n <= 0) throw bad('--limit must be a positive integer.');
        args.limit = n;
        break;
      }
      case '--dataset':
        args.dataset = take();
        break;
      case '--out':
        args.out = take();
        break;
      case '--json':
        args.json = true;
        break;
      case '--live':
        args.live = true;
        break;
      case '--check':
        args.check = true;
        break;
      case '--record':
        args.record = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw bad(`Unknown flag "${a}".`);
    }
  }
  return args;
}
