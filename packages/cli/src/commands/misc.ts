/** doctor, completion, help. */
import { completionScript } from '../completion.ts';
import { renderChecks, runDoctor } from '../doctor/run.ts';
import { nodeExec } from '../exec.ts';
import { EXIT_FAILURE, UsageError } from '../exit-codes.ts';
import { commandHelp, mainHelp } from '../help.ts';
import type { CommandContext } from '../runtime.ts';
import { findCommand, SHELLS } from '../spec.ts';

export async function doctorCommand(c: CommandContext): Promise<number> {
  c.progress.start('Running checks');
  let checks: Awaited<ReturnType<typeof runDoctor>>;
  try {
    checks = await runDoctor({
      registry: c.deps.registry,
      ctx: c.deps.ctx,
      exec: c.deps.exec ?? nodeExec,
      cwd: c.cwd,
      nodeVersion: process.version,
    });
  } finally {
    c.progress.stop();
  }
  c.out.text(c.json ? `${JSON.stringify(checks, null, 2)}\n` : renderChecks(checks));
  return checks.some((x) => x.status === 'fail') ? EXIT_FAILURE : 0;
}

export async function completionCommand(c: CommandContext): Promise<number> {
  const shell = c.positionals[0];
  if (!shell || !SHELLS.includes(shell as (typeof SHELLS)[number]) || c.positionals.length > 1) {
    throw new UsageError(shell ? `Unknown shell "${shell}".` : 'Pass a shell.', `One of: ${SHELLS.join(', ')}.`);
  }
  c.out.text(completionScript(shell as (typeof SHELLS)[number]));
  return 0;
}

export async function helpCommand(c: CommandContext): Promise<number> {
  const name = c.positionals[0];
  if (!name) {
    c.out.text(mainHelp());
    return 0;
  }
  const cmd = findCommand(name);
  if (!cmd) throw new UsageError(`Unknown command "${name}".`, 'Run `vid2context --help` for the list.');
  c.out.text(commandHelp(cmd));
  return 0;
}
