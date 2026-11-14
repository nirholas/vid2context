/**
 * vid2context CLI (minimal). Program output goes to stdout; logs, errors and
 * the attempts list go to stderr, so `vid2context URL > transcript.txt` is clean.
 */
import { parseArgs } from 'node:util';
import {
  type Attempt,
  attemptsOf,
  type Ctx,
  formatters,
  getVideoContext,
  type Registry,
  render,
  type TranscriptMode,
  Vid2ContextError,
} from '@vid2context/core';

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface RunDeps {
  registry: Registry;
  ctx: Ctx;
  io: Io;
}

const MODES: TranscriptMode[] = ['auto', 'captions', 'stt', 'video'];

export function usage(): string {
  const formats = Object.values(formatters)
    .map((f) => `  ${f.id.padEnd(10)} ${f.description}`)
    .join('\n');
  return `vid2context: turn any video into context for AI agents.

Usage:
  vid2context <url-or-file> [options]

Options:
  --format <id>     Output format (default: text)
  --timestamps      Prefix lines with timestamps where the format allows
  --mode <mode>     auto | captions | stt | video (default: auto)
  --lang <code>     Preferred transcript language, e.g. en, de, pt-BR
  --verbose         Log progress to stderr
  -h, --help        Show this help
  -v, --version     Show the version

Formats:
${formats}

Examples:
  vid2context https://www.youtube.com/watch?v=jNQXAC9IVRw --timestamps
  vid2context ./interview.mp3 --format json > interview.json
`;
}

export function formatAttempts(attempts: Attempt[]): string {
  if (attempts.length === 0) return '';
  const rows = attempts.map((a) => {
    const what = [a.reason, a.detail].filter(Boolean).join(': ');
    return `  ${a.stage.padEnd(8)} ${a.outcome.padEnd(7)} ${a.id}${what ? `  ${what}` : ''}`;
  });
  return `Attempts:\n${rows.join('\n')}\n`;
}

export function formatError(err: unknown): string {
  if (err instanceof Vid2ContextError) {
    return `error (${err.code}): ${err.message}\n${err.hint ? `hint: ${err.hint}\n` : ''}${formatAttempts(attemptsOf(err))}`;
  }
  return `error: ${err instanceof Error ? err.message : String(err)}\n${formatAttempts(attemptsOf(err))}`;
}

/** Run the CLI. Returns the process exit code: 0 ok, 1 failure, 2 usage error. */
export async function run(argv: string[], deps: RunDeps, version: string): Promise<number> {
  const { io } = deps;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', default: 'text' },
        timestamps: { type: 'boolean', default: false },
        mode: { type: 'string', default: 'auto' },
        lang: { type: 'string' },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(usage());
    return 0;
  }
  if (values.version) {
    io.stdout(`${version}\n`);
    return 0;
  }
  const input = positionals[0];
  const format = String(values.format);
  const mode = String(values.mode) as TranscriptMode;
  if (!input || positionals.length > 1) {
    io.stderr(`Pass exactly one video URL or file path.\n\n${usage()}`);
    return 2;
  }
  if (!formatters[format]) {
    io.stderr(`Unknown format "${format}". Available: ${Object.keys(formatters).join(', ')}.\n`);
    return 2;
  }
  if (!MODES.includes(mode)) {
    io.stderr(`Unknown mode "${mode}". Available: ${MODES.join(', ')}.\n`);
    return 2;
  }

  try {
    const context = await getVideoContext(
      deps.registry,
      input,
      { mode, language: typeof values.lang === 'string' ? values.lang : undefined },
      deps.ctx,
    );
    io.stdout(render(context, format, { timestamps: Boolean(values.timestamps) }));
    if (values.verbose) io.stderr(formatAttempts(context.attempts));
    return 0;
  } catch (err) {
    io.stderr(formatError(err));
    return 1;
  }
}
