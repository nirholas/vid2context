/**
 * vid2context CLI. Program output goes to stdout (or the --out file); logs,
 * progress, errors, hints and the attempts list go to stderr, so
 * `vid2context URL > transcript.txt` is clean. Every command is a function of
 * injected dependencies (RunDeps), so tests run them in-process.
 */
import { bool, parseCli } from './args.ts';
import { configCommand } from './commands/config.ts';
import { collectionCommand, libraryCommand, searchCommand } from './commands/library.ts';
import { completionCommand, doctorCommand, helpCommand } from './commands/misc.ts';
import { modelsCommand } from './commands/models.ts';
import { mcpCommand, serveCommand } from './commands/servers.ts';
import { bundleCommand, formatsCommand, getCommand, listCommand, packCommand } from './commands/video.ts';
import { EXIT_INTERRUPTED, EXIT_USAGE, exitCodeFor } from './exit-codes.ts';
import { commandHelp, mainHelp } from './help.ts';
import { errorJson, formatError } from './output.ts';
import { type CommandContext, makeContext, type RunDeps } from './runtime.ts';

export { listModels, type ModelInfo } from './commands/models.ts';
export { completionScript } from './completion.ts';
export { EXIT_BY_CODE, exitCodeFor, exitCodeTable, UsageError } from './exit-codes.ts';
export { mainHelp as usage } from './help.ts';
export { formatAttempts, formatError, type Io } from './output.ts';
export type { RunDeps } from './runtime.ts';

type Command = (c: CommandContext) => Promise<number>;

const HANDLERS: Record<string, Command> = {
  get: getCommand,
  list: listCommand,
  formats: formatsCommand,
  pack: packCommand,
  bundle: bundleCommand,
  search: searchCommand,
  library: libraryCommand,
  collection: collectionCommand,
  models: modelsCommand,
  doctor: doctorCommand,
  config: configCommand,
  serve: serveCommand,
  mcp: mcpCommand,
  completion: completionCommand,
  help: helpCommand,
};

/** Run the CLI. Returns the process exit code (see exit-codes.ts). */
export async function run(argv: string[], deps: RunDeps, version: string): Promise<number> {
  const { io } = deps;
  const wantsJson = argv.includes('--json');
  const verbose = argv.includes('--verbose');
  const fail = (err: unknown): number => {
    if (deps.ctx.signal?.aborted) {
      io.stderr('interrupted\n');
      return EXIT_INTERRUPTED;
    }
    io.stderr(wantsJson ? errorJson(err) : formatError(err, verbose));
    return exitCodeFor(err);
  };

  let ctx: CommandContext;
  try {
    const args = parseCli(argv);
    if (bool(args.values, 'version')) {
      io.stdout(`${version}\n`);
      return 0;
    }
    if (bool(args.values, 'help')) {
      io.stdout(args.explicit ? commandHelp(args.command) : mainHelp());
      return 0;
    }
    if (!args.explicit && args.positionals.length === 0) {
      io.stderr(`${mainHelp()}\nerror: pass a video URL or file path, or a command.\n`);
      return EXIT_USAGE;
    }
    ctx = makeContext(deps, args, version);
    ctx.out.precheck();
  } catch (err) {
    return fail(err);
  }

  try {
    const handler = HANDLERS[ctx.args.command.name] as Command;
    const code = await handler(ctx);
    const wrote = await ctx.out.flush();
    if (wrote) ctx.note(`wrote ${wrote.path} (${wrote.bytes} bytes)`);
    return code;
  } catch (err) {
    ctx.progress.stop();
    return fail(err);
  }
}
