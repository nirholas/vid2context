/**
 * Command line parsing on node:util parseArgs, driven by the table in spec.ts.
 * Unknown flags and mistyped commands fail with a hint naming the closest
 * valid one.
 */
import { parseArgs } from 'node:util';
import { UsageError } from './exit-codes.ts';
import { COMMANDS, type CommandSpec, FLAGS, findCommand, flagsFor } from './spec.ts';

export type FlagValue = string | boolean | string[] | undefined;

export interface ParsedArgs {
  command: CommandSpec;
  /** False when the command was inferred (`vid2context <url>` runs get). */
  explicit: boolean;
  /** Positionals after the command name. */
  positionals: string[];
  values: Record<string, FlagValue>;
}

/** Edit distance, for "did you mean" hints. */
export function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      prev[j] = Math.min(up + 1, (prev[j - 1] as number) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] as number;
}

/** The candidate closest to `word`, when it is close enough to be a likely typo. */
export function closest(word: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = c.startsWith(word) && word.length >= 3 ? 0.5 : distance(word, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

/** `--comments` takes an optional number: rewrite to `--comments=<n>` or `--comments=all` so parseArgs can read it. */
function normalize(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (a === '--comments') {
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        out.push(`--comments=${next}`);
        i++;
      } else out.push('--comments=all');
    } else out.push(a);
  }
  return out;
}

function looksLikeCommandTypo(word: string): string | undefined {
  // Inputs carry a dot, slash or colon, or are 11-character YouTube ids.
  if (/[./:\\]/.test(word) || /^[\w-]{11}$/.test(word)) return undefined;
  return closest(
    word,
    COMMANDS.map((c) => c.name),
  );
}

export function parseCli(argv: string[]): ParsedArgs {
  const options = Object.fromEntries(
    Object.values(FLAGS).map((f) => [f.name, { type: f.type, short: f.short, multiple: f.multiple }]),
  ) as NonNullable<Parameters<typeof parseArgs>[0]>['options'];
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: normalize(argv), options, allowPositionals: true, strict: true, tokens: true });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const flag = /'([^']+)'/.exec(e.message)?.[1] ?? '';
      const bare = flag.replace(/^-+/, '').split('=')[0] ?? '';
      const near = closest(bare, Object.keys(FLAGS));
      throw new UsageError(
        `Unknown flag ${flag}.`,
        near ? `Did you mean --${near}? Run \`vid2context --help\` for every flag.` : 'Run `vid2context --help` for every flag.',
      );
    }
    if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      throw new UsageError(e.message.split('\n')[0] ?? e.message, 'Flags that take a value need it right after them: --format json.');
    }
    throw new UsageError(e.message);
  }

  const positionals = [...parsed.positionals];
  const first = positionals[0];
  let command = first !== undefined ? findCommand(first) : undefined;
  const explicit = command !== undefined;
  if (command) positionals.shift();
  else {
    if (first !== undefined) {
      const typo = looksLikeCommandTypo(first);
      if (typo) throw new UsageError(`Unknown command "${first}".`, `Did you mean \`vid2context ${typo}\`?`);
    }
    command = findCommand('get') as CommandSpec;
  }

  const allowed = new Set(flagsFor(command).map((f) => f.name));
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== 'option' || allowed.has(token.name)) continue;
    const users = COMMANDS.filter((c) => c.flags.includes(token.name)).map((c) => c.name);
    throw new UsageError(
      `--${token.name} does not apply to \`${command.name}\`.`,
      users.length ? `It is a flag of: ${users.join(', ')}. Run \`vid2context ${command.name} --help\`.` : undefined,
    );
  }
  return { command, explicit, positionals, values: parsed.values as Record<string, FlagValue> };
}

// ---------------------------------------------------------------- value helpers

export function str(values: Record<string, FlagValue>, name: string): string | undefined {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
}

export function bool(values: Record<string, FlagValue>, name: string): boolean {
  return values[name] === true;
}

/** Comma-separated and repeatable flags as one list. */
export function list(values: Record<string, FlagValue>, name: string): string[] | undefined {
  const v = values[name];
  if (v === undefined || typeof v === 'boolean') return undefined;
  const items = (Array.isArray(v) ? v : [v])
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export function positiveInt(values: Record<string, FlagValue>, name: string): number | undefined {
  const v = str(values, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError(`--${name} must be a whole number of 1 or more, got "${v}".`);
  return Number(v);
}

export function choice<T extends string>(values: Record<string, FlagValue>, name: string, allowed: readonly T[]): T | undefined {
  const v = str(values, name);
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) {
    const near = closest(v, [...allowed]);
    throw new UsageError(
      `Unknown ${name} "${v}".`,
      `${near ? `Did you mean ${near}? ` : ''}Available: ${allowed.join(', ')}.`,
    );
  }
  return v as T;
}
