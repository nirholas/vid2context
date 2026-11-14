/**
 * Chooses the command a client runs to start the local stdio server, and says
 * why. Order: an explicit --command, then --from-source (the repo's tsx entry,
 * for contributors), then a globally installed `vid2context-mcp`, then the
 * published package through npx (the default every client config uses).
 */
import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_COMMAND, MCP_PACKAGE } from '@vid2context/discovery';

export interface ServerCommand {
  command: string;
  args: string[];
  /** One sentence for the user: what was chosen and why. */
  reason: string;
}

/** Repo root, found from this file's location (integrations/install/src). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Splits a command line on spaces, honoring single and double quotes. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  let has = false;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === ' ' || c === '\t') {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** First executable named `name` on PATH, skipping node_modules/.bin folders (npx and npm run add those). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir || dir.includes(`node_modules${sep}.bin`) || dir.includes('node_modules/.bin')) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // unreadable PATH entry: skip it
      }
    }
  }
  return undefined;
}

export interface CommandOptions {
  command?: string;
  fromSource?: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export function chooseServerCommand(opts: CommandOptions): ServerCommand {
  if (opts.command) {
    const [command, ...args] = splitCommandLine(opts.command);
    if (command) return { command, args, reason: 'Using the command you passed with --command.' };
  }
  if (opts.fromSource) {
    const bin = join(REPO_ROOT, 'packages', 'mcp', 'src', 'bin.ts');
    return {
      command: 'npx',
      args: ['tsx', bin],
      reason: `Running the server from this checkout (${bin}) because of --from-source. Run npm install in the repo first.`,
    };
  }
  const global = findOnPath(MCP_PACKAGE.bin, opts.env, opts.platform);
  if (global) {
    return {
      command: MCP_PACKAGE.bin,
      args: [],
      reason: `Found ${MCP_PACKAGE.bin} installed globally (${global}), so the client runs it directly.`,
    };
  }
  return {
    command: MCP_COMMAND.command,
    args: [...MCP_COMMAND.args],
    reason: `Using the published package (${MCP_COMMAND.command} ${MCP_COMMAND.args.join(' ')}); npx fetches it on first start. Contributors can pass --from-source to run this checkout instead.`,
  };
}
