#!/usr/bin/env -S npx tsx
/**
 * vid2context installer for MCP clients.
 *
 *   npx tsx integrations/install/src/bin.ts <client> [--scope user|project]
 *     [--remote <url> [--token <token> | --token-env <VAR>]] [--command <cmd>] [--from-source]
 *     [--env KEY=VALUE]... [--legacy] [--no-cli] [--dry-run] [--uninstall] [--json]
 *   npx tsx integrations/install/src/bin.ts list [--json]
 *
 * stdout carries the result (text, or JSON with --json); errors go to stderr.
 */
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Vid2ContextError } from '@vid2context/core';
import {
  claudeCodeCommand,
  codexCommand,
  cursorInstallUrl,
  geminiCommand,
  MCP_COMMAND,
  mcpServersJson,
  vscodeInstallUrl,
} from '@vid2context/discovery';
import { CLIENTS, type Environment, type Scope, type ServerSpec, vscodeLegacyPath } from './clients.ts';
import { chooseServerCommand, type ServerCommand } from './command.ts';
import { type InstallResult, install } from './install.ts';

export interface ParsedArgs {
  client?: string;
  scope?: Scope;
  remote?: string;
  token?: string;
  tokenEnv?: string;
  command?: string;
  fromSource: boolean;
  env: Record<string, string>;
  legacy: boolean;
  noCli: boolean;
  dryRun: boolean;
  uninstall: boolean;
  json: boolean;
  help: boolean;
}

export const USAGE = `Usage: npx tsx integrations/install/src/bin.ts <client|list> [options]

Clients: ${CLIENTS.map((c) => c.id).join(', ')}

Options:
  --scope user|project   Where to install (default: user)
  --remote <url>         Use a remote vid2context MCP endpoint (Streamable HTTP) instead of the local server
  --token <token>        Send Authorization: Bearer <token> to the remote endpoint
  --token-env <VAR>      Reference a token from an env var instead of writing it into the config
  --command "<cmd>"      Start the local server with this command
  --from-source          Run this checkout (npx tsx packages/mcp/src/bin.ts) instead of the published package
  --env KEY=VALUE        Write an env var into the client config (repeatable). Keys are never written otherwise
  --legacy               VS Code only: write the deprecated .vscode/mcp.json format
  --no-cli               Claude Code only: edit .mcp.json even when the claude CLI is on PATH
  --dry-run              Print the diff and write nothing
  --uninstall            Remove only the vid2context entry
  --json                 Print the result as JSON
`;

const SCOPES: Scope[] = ['user', 'project'];

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    fromSource: false,
    env: {},
    legacy: false,
    noCli: false,
    dryRun: false,
    uninstall: false,
    json: false,
    help: false,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Vid2ContextError('bad-request', `${flag} needs a value.`, { hint: USAGE });
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case '--scope': {
        const s = value(i++, a);
        if (!SCOPES.includes(s as Scope)) throw new Vid2ContextError('bad-request', `Unknown scope: ${s}`, { hint: 'Use --scope user or --scope project.' });
        out.scope = s as Scope;
        break;
      }
      case '--remote':
        out.remote = value(i++, a);
        break;
      case '--token':
        out.token = value(i++, a);
        break;
      case '--token-env':
        out.tokenEnv = value(i++, a);
        break;
      case '--command':
        out.command = value(i++, a);
        break;
      case '--env': {
        const kv = value(i++, a);
        const eq = kv.indexOf('=');
        if (eq <= 0) throw new Vid2ContextError('bad-request', `--env expects KEY=VALUE, got ${kv}`, { hint: 'For example --env OLLAMA_BASE_URL=http://localhost:11434/v1' });
        out.env[kv.slice(0, eq)] = kv.slice(eq + 1);
        break;
      }
      case '--from-source':
        out.fromSource = true;
        break;
      case '--legacy':
        out.legacy = true;
        break;
      case '--no-cli':
        out.noCli = true;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--uninstall':
        out.uninstall = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        if (a.startsWith('-')) throw new Vid2ContextError('bad-request', `Unknown option: ${a}`, { hint: USAGE });
        if (out.client) throw new Vid2ContextError('bad-request', `Unexpected argument: ${a}`, { hint: USAGE });
        out.client = a;
    }
  }
  if ((out.token || out.tokenEnv) && !out.remote) {
    throw new Vid2ContextError('bad-request', '--token and --token-env only apply with --remote.', { hint: 'Add --remote <url>, or drop the token.' });
  }
  if (out.token && out.tokenEnv) throw new Vid2ContextError('bad-request', 'Pass --token or --token-env, not both.', { hint: 'Prefer --token-env so the token stays out of the config file.' });
  if (out.remote && (out.command || out.fromSource || Object.keys(out.env).length > 0)) {
    throw new Vid2ContextError('bad-request', '--command, --from-source and --env apply to the local server, not --remote.', { hint: 'Drop them, or drop --remote.' });
  }
  if (out.remote) {
    let u: URL | undefined;
    try {
      u = new URL(out.remote);
    } catch {
      u = undefined;
    }
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
      throw new Vid2ContextError('bad-request', `--remote needs an http(s) URL, got ${out.remote}`, { hint: 'For example --remote https://your-host/mcp' });
    }
  }
  return out;
}

export function currentEnvironment(): Environment {
  return { home: homedir(), cwd: process.cwd(), platform: process.platform, env: process.env };
}

function serverSpec(args: ParsedArgs, e: Environment): { server: ServerSpec; chosen?: ServerCommand } {
  if (args.remote) return { server: { kind: 'remote', url: args.remote, token: args.token, tokenEnv: args.tokenEnv } };
  const chosen = chooseServerCommand({ command: args.command, fromSource: args.fromSource, env: e.env, platform: e.platform });
  return { server: { kind: 'local', command: chosen.command, args: chosen.args, env: args.env }, chosen };
}

const VERIFY: Record<string, string> = {
  'claude-code': 'Run `claude mcp list`, or type /mcp inside Claude Code.',
  'claude-desktop': 'Quit and reopen Claude Desktop, then look for vid2context under the tools menu in a new chat.',
  cursor: 'Open Cursor Settings, MCP, and check that vid2context is listed and enabled.',
  vscode: 'Run "MCP: List Servers" from the Command Palette, then start vid2context.',
  codex: 'Run `codex mcp list`, or /mcp inside Codex.',
  'gemini-cli': 'Run `gemini mcp list`, or /mcp inside Gemini CLI.',
};

/** Ready-made one-click links and commands from @vid2context/discovery, for the default published command. */
function quickLinks(client: string): string | undefined {
  switch (client) {
    case 'claude-code':
      return `Same thing as one command: ${claudeCodeCommand}`;
    case 'cursor':
      return `One-click install link: ${cursorInstallUrl()}`;
    case 'vscode':
      return `One-click install link: ${vscodeInstallUrl()}`;
    case 'codex':
      return `Same thing with the Codex CLI: ${codexCommand}`;
    case 'gemini-cli':
      return `Or install the Gemini CLI extension: ${geminiCommand}`;
    case 'claude-desktop':
      return `The block to paste by hand:\n${mcpServersJson()}`;
    default:
      return undefined;
  }
}

function redact(text: string, token?: string): string {
  return token ? text.split(token).join('<token>') : text;
}

export function notesFor(args: ParsedArgs, result: InstallResult, chosen?: ServerCommand): string[] {
  const notes: string[] = [];
  if (result.action === 'uninstall') return notes;
  if (chosen) notes.push(chosen.reason);
  if (!args.remote) {
    notes.push(
      Object.keys(args.env).length > 0
        ? 'The --env values you passed are stored in the client config in plain text.'
        : 'No API keys were written. Keys are optional; put them in your shell environment, or pass --env VID2CONTEXT_ENV_FILE=/path/to/.env so the server loads your .env file.',
    );
  } else if (!args.token && !args.tokenEnv) {
    notes.push('No token given: the client connects without one, or signs in with OAuth when the endpoint offers it.');
  } else if (args.token) {
    notes.push('The token is stored in the client config in plain text. Use --token-env <VAR> to reference an env var instead.');
  }
  if (result.client === 'codex' && result.scope === 'project') notes.push('Codex reads .codex/config.toml only in projects you have trusted.');
  if (result.client === 'vscode' && args.legacy) notes.push('The .vscode/mcp.json format is deprecated by VS Code and will be removed in February 2027.');
  const verify = VERIFY[result.client];
  if (verify) notes.push(`Verify: ${verify}`);
  const sameAsDefault = chosen && chosen.command === MCP_COMMAND.command && chosen.args.join(' ') === MCP_COMMAND.args.join(' ');
  const link = sameAsDefault && !args.legacy && Object.keys(args.env).length === 0 ? quickLinks(result.client) : undefined;
  if (link) notes.push(link);
  return notes;
}

function renderText(result: InstallResult, notes: string[], token?: string): string {
  const lines: string[] = [];
  const where = result.method === 'claude-cli' ? `${result.path} (through the claude CLI)` : result.path;
  if (!result.changed) {
    lines.push(
      result.action === 'install'
        ? `${result.label}: vid2context is already installed in ${where}. Nothing changed.`
        : `${result.label}: vid2context is not in ${where}. Nothing changed.`,
    );
  } else if (result.dryRun) {
    lines.push(`${result.label}: dry run, nothing written. ${result.action === 'install' ? 'Would install into' : 'Would remove from'} ${where}:`);
  } else {
    lines.push(`${result.label}: ${result.action === 'install' ? 'installed vid2context into' : 'removed vid2context from'} ${where}.`);
    if (result.backup) lines.push(`Backup: ${result.backup}`);
  }
  for (const c of result.commands) lines.push(`${result.dryRun ? 'Would run' : 'Ran'}: ${c.map((p) => (/\s/.test(p) ? JSON.stringify(p) : p)).join(' ')}`);
  if (result.diff && (result.dryRun || result.changed)) lines.push('', result.diff.trimEnd());
  if (notes.length) lines.push('', ...notes);
  return `${redact(lines.join('\n'), token)}\n`;
}

export function listClients(e: Environment): { id: string; label: string; scopes: Record<string, string>; note?: string; docs: { url: string; verified: string }[] }[] {
  return CLIENTS.map((c) => {
    const scopes: Record<string, string> = {};
    for (const s of c.scopes) {
      const p = c.path(s, e);
      if (p) scopes[s] = p;
    }
    if (c.id === 'vscode') scopes['project (--legacy)'] = vscodeLegacyPath(e);
    return { id: c.id, label: c.label, scopes, note: c.note, docs: c.docs };
  });
}

export function main(argv: string[], e: Environment = currentEnvironment()): number {
  const args = parseArgs(argv);
  const write = (s: string) => process.stdout.write(s);
  if (args.help || !args.client) {
    write(USAGE);
    return args.help ? 0 : 1;
  }
  if (args.client === 'list') {
    const rows = listClients(e);
    if (args.json) {
      write(`${JSON.stringify(rows, null, 2)}\n`);
    } else {
      for (const r of rows) {
        write(`${r.id}  ${r.label}\n`);
        for (const [s, p] of Object.entries(r.scopes)) write(`  ${s}: ${p}\n`);
        if (r.note) write(`  ${r.note}\n`);
      }
      write('\nWindsurf is not supported: its official MCP docs now redirect to Devin Desktop, so the config format could not be verified.\n');
    }
    return 0;
  }
  const { server, chosen } = args.uninstall ? { server: undefined, chosen: undefined } : serverSpec(args, e);
  const result = install({
    client: args.client,
    scope: args.scope,
    uninstall: args.uninstall,
    dryRun: args.dryRun,
    legacy: args.legacy,
    server,
    environment: e,
    useClaudeCli: !args.noCli,
  });
  const notes = notesFor(args, result, chosen);
  if (args.json) {
    const payload = { ...result, notes, server: chosen ? { command: chosen.command, args: chosen.args } : undefined };
    write(`${redact(JSON.stringify(payload, null, 2), args.token)}\n`);
  } else {
    write(renderText(result, notes, args.token));
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    const e = err instanceof Vid2ContextError ? err : undefined;
    console.error(`error${e ? ` (${e.code})` : ''}: ${err instanceof Error ? err.message : String(err)}`);
    if (e?.hint) console.error(`hint: ${e.hint}`);
    process.exitCode = 1;
  }
}
