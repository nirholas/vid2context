/** `--help` text, generated from the command table in spec.ts. */
import { formatters } from '@vid2context/core';
import { exitCodeTable } from './exit-codes.ts';
import { table } from './output.ts';
import { COMMANDS, type CommandSpec, FLAGS, type FlagSpec, GLOBAL_FLAGS } from './spec.ts';

function flagRows(flags: FlagSpec[]): string {
  return table(
    flags.map((f) => [`  ${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.arg ? ` ${f.arg}` : ''}`, f.description]),
  );
}

function globalFlags(): FlagSpec[] {
  return GLOBAL_FLAGS.map((n) => FLAGS[n]).filter((f): f is FlagSpec => Boolean(f));
}

export function mainHelp(): string {
  const cmds = table(COMMANDS.map((c) => [`  ${c.name}`, c.summary]));
  const formats = table(Object.values(formatters).map((f) => [`  ${f.id}`, f.description]));
  const codes = table(exitCodeTable().map((r) => [`  ${r.code}`, r.name, r.meaning]));
  return `vid2context: turn any video into context for AI agents.

Usage:
  vid2context <input> [flags]            same as \`vid2context get <input>\`
  vid2context <command> [args] [flags]

Commands:
${cmds}

Global flags:
${flagRows(globalFlags())}

Formats:
${formats}

Exit codes:
${codes}

Keys are read from the environment and ./.env (shell variables win); every key is optional.
Run \`vid2context <command> --help\` for a command's arguments and flags.

Examples:
  vid2context https://www.youtube.com/watch?v=jNQXAC9IVRw --timestamps
  vid2context ./interview.mp3 --format json --out interview.json
  vid2context doctor
`;
}

export function commandHelp(c: CommandSpec): string {
  const own = c.flags.map((n) => FLAGS[n]).filter((f): f is FlagSpec => Boolean(f));
  const parts = [`vid2context ${c.name}: ${c.summary}.`, '', 'Usage:', `  vid2context ${c.name}${c.args ? ` ${c.args}` : ''} [flags]`];
  if (c.subcommands) {
    parts.push('', 'Subcommands:', table(c.subcommands.map((s) => [`  ${s.name}${s.args ? ` ${s.args}` : ''}`, s.summary])));
  }
  if (own.length) parts.push('', 'Flags:', flagRows(own));
  parts.push('', 'Global flags:', flagRows(globalFlags()));
  if (c.notes?.length) parts.push('', ...c.notes);
  parts.push('', 'Examples:', ...c.examples.map((e) => `  ${e}`));
  return `${parts.join('\n')}\n`;
}
