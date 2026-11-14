/**
 * Install and uninstall planning and execution. A run reads the client's
 * config, computes the new text with an edit that touches only the
 * vid2context entry, and writes it (backup first, atomic rename) only when
 * something changed. Files that fail to parse are never written: the error
 * carries the exact snippet to add by hand.
 */
import { execFileSync } from 'node:child_process';
import { Vid2ContextError } from '@vid2context/core';
import {
  type Client,
  type Environment,
  getClient,
  type JsonClient,
  type Scope,
  SERVER_NAME,
  type ServerSpec,
  type TomlClient,
  vscodeLegacyPath,
} from './clients.ts';
import { findOnPath } from './command.ts';
import { lineDiff } from './diff.ts';
import { backup, readIfExists, writeAtomic } from './files.ts';
import { JsonParseError, member, parseJsonc, removeMember, setMember, toValue } from './jsonc.ts';
import { findTable, parseToml, removeTable, renderTable, setTable, TomlParseError } from './toml.ts';

export interface InstallOptions {
  client: string;
  scope?: Scope;
  uninstall?: boolean;
  dryRun?: boolean;
  /** VS Code only: the deprecated .vscode/mcp.json format. */
  legacy?: boolean;
  /** What to install. Ignored for --uninstall. */
  server?: ServerSpec;
  environment: Environment;
  /** Claude Code only: false skips the claude CLI even when it is on PATH. */
  useClaudeCli?: boolean;
  now?: Date;
}

export interface InstallResult {
  client: string;
  label: string;
  action: 'install' | 'uninstall';
  scope: Scope;
  method: 'file' | 'claude-cli';
  path: string;
  /** True when the config differs (or would differ, with --dry-run). */
  changed: boolean;
  /** True when a file was written or a CLI command ran. */
  wrote: boolean;
  dryRun: boolean;
  backup?: string;
  diff: string;
  /** Commands run (or, with --dry-run, that would run) for the claude CLI method. */
  commands: string[][];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

/**
 * True when `have` already holds every field of `want`. Extra fields are
 * allowed, so an entry another client wrote into a shared file (VS Code and
 * Claude Code both read a workspace .mcp.json) or a key the user added is
 * kept, and the two installers do not overwrite each other.
 */
export function entryMatches(want: Record<string, unknown>, have: unknown): boolean {
  if (!have || typeof have !== 'object' || Array.isArray(have)) return false;
  const h = have as Record<string, unknown>;
  return Object.entries(want).every(([k, v]) => deepEqual(v, h[k]));
}

function parseFailure(path: string, err: Error, snippet: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', `Could not parse ${path}: ${err.message}. The file was not changed.`, {
    hint: `Fix the file, or add this by hand:\n${snippet}`,
    cause: err,
  });
}

function jsonSnippet(key: string, entry: Record<string, unknown>): string {
  return JSON.stringify({ [key]: { [SERVER_NAME]: entry } }, null, 2);
}

/** New text for a JSON client config. Throws on parse failure without touching anything. */
export function editJson(text: string, opts: { key: string; entry?: Record<string, unknown>; path: string }): string {
  const { key, entry, path } = opts;
  const snippet = entry ? jsonSnippet(key, entry) : `Remove "${SERVER_NAME}" from "${key}".`;
  if (text.trim() === '') return entry ? `${jsonSnippet(key, entry)}\n` : text;
  let root: ReturnType<typeof parseJsonc>;
  try {
    root = parseJsonc(text, { comments: true });
  } catch (err) {
    if (err instanceof JsonParseError) throw parseFailure(path, err, snippet);
    throw err;
  }
  if (root.kind !== 'object') throw parseFailure(path, new Error('the top level is not a JSON object'), snippet);
  const servers = member(root, key);
  if (!servers) return entry ? setMember(text, root, key, { [SERVER_NAME]: entry }) : text;
  if (servers.value.kind !== 'object') throw parseFailure(path, new Error(`"${key}" is not an object`), snippet);
  const existing = member(servers.value, SERVER_NAME);
  let out: string;
  if (!entry) {
    out = existing ? removeMember(text, servers.value, SERVER_NAME) : text;
  } else if (existing && entryMatches(entry, toValue(existing.value))) {
    out = text;
  } else {
    out = setMember(text, servers.value, SERVER_NAME, entry);
  }
  // Belt and braces: the edit must still parse and say exactly what we meant.
  const check = member(parseJsonc(out, { comments: true }), key);
  const now = check?.value.kind === 'object' ? member(check.value, SERVER_NAME) : undefined;
  if (entry ? !now || !entryMatches(entry, toValue(now.value)) : now) {
    throw new Vid2ContextError('bad-request', `Editing ${path} did not produce the expected entry. The file was not changed.`, {
      hint: `Add this by hand:\n${snippet}`,
    });
  }
  return out;
}

/** New text for Codex's config.toml. */
export function editToml(text: string, client: TomlClient, opts: { entry?: Record<string, unknown>; path: string }): string {
  const { entry, path } = opts;
  const tablePath = [...client.table, SERVER_NAME];
  const snippet = entry ? renderTable(tablePath, entry) : `Remove the [${tablePath.join('.')}] table.`;
  let data: Record<string, unknown>;
  try {
    data = parseToml(text);
  } catch (err) {
    if (err instanceof TomlParseError) throw parseFailure(path, err, snippet);
    throw err;
  }
  const lookup = (d: Record<string, unknown>) =>
    tablePath.reduce<unknown>((t, k) => (t && typeof t === 'object' ? (t as Record<string, unknown>)[k] : undefined), d);
  const existing = lookup(data);
  if (existing !== undefined && !findTable(text, tablePath)) {
    throw new Vid2ContextError(
      'bad-request',
      `${path} defines ${tablePath.join('.')} inline, which this installer does not rewrite. The file was not changed.`,
      {
        hint: `Replace that definition by hand with:\n${snippet}`,
      },
    );
  }
  let out: string;
  if (!entry) out = existing === undefined ? text : removeTable(text, tablePath);
  else if (entryMatches(entry, existing)) out = text;
  else out = setTable(text, tablePath, entry);
  const now = lookup(parseToml(out));
  if (entry ? !entryMatches(entry, now) : now !== undefined) {
    throw new Vid2ContextError('bad-request', `Editing ${path} did not produce the expected table. The file was not changed.`, {
      hint: `Add this by hand:\n${snippet}`,
    });
  }
  return out;
}

function configPath(client: Client, scope: Scope, opts: InstallOptions): string {
  if (opts.legacy) {
    if (client.id !== 'vscode')
      throw new Vid2ContextError('bad-request', '--legacy only applies to vscode.', { hint: 'Drop --legacy.' });
    if (scope !== 'project') {
      throw new Vid2ContextError('bad-request', 'The legacy VS Code format is only supported per workspace.', {
        hint: 'Use --legacy --scope project, or drop --legacy to write the current Copilot user config.',
      });
    }
    return vscodeLegacyPath(opts.environment);
  }
  const path = client.path(scope, opts.environment);
  if (!path)
    throw new Vid2ContextError('unsupported-input', `${client.label} has no ${scope} config on this OS.`, {
      hint: `Use --scope ${client.defaultScope}.`,
    });
  return path;
}

function resolveScope(client: Client, scope: Scope | undefined): Scope {
  const s = scope ?? client.defaultScope;
  if (!client.scopes.includes(s)) {
    throw new Vid2ContextError('bad-request', `${client.label} has no ${s} scope.`, {
      hint: `Use --scope ${client.scopes.join(' or ')}.`,
    });
  }
  return s;
}

function serverOrThrow(opts: InstallOptions): ServerSpec | undefined {
  if (opts.uninstall) return undefined;
  if (!opts.server)
    throw new Vid2ContextError('bad-request', 'No server to install.', { hint: 'Pass a server spec, or use --uninstall.' });
  return opts.server;
}

export function install(opts: InstallOptions): InstallResult {
  const client = getClient(opts.client);
  const scope = resolveScope(client, opts.scope);
  const server = serverOrThrow(opts);
  if (client.id === 'claude-code') {
    const claude =
      opts.useClaudeCli === false ? undefined : findOnPath('claude', opts.environment.env, opts.environment.platform);
    if (claude) return viaClaudeCli(client as JsonClient, claude, scope, server, opts);
    if (scope === 'user') {
      throw new Vid2ContextError(
        'unavailable',
        'The claude CLI is not on PATH, and user-scope servers live in ~/.claude.json, which Claude Code rewrites while it runs.',
        {
          hint: 'Install Claude Code (npm install -g @anthropic-ai/claude-code) and rerun, or use --scope project to write .mcp.json in this folder.',
        },
      );
    }
  }
  const path = configPath(client, scope, opts);
  const before = readIfExists(path);
  const text = before ?? '';
  let after: string;
  if (client.format === 'json') {
    const entry = server ? client.entry(server, { legacy: opts.legacy }) : undefined;
    after = editJson(text, { key: client.key({ legacy: opts.legacy }), entry, path });
  } else {
    const entry = server ? client.entry(server) : undefined;
    after = editToml(text, client, { entry, path });
  }
  const changed = after !== text;
  const result: InstallResult = {
    client: client.id,
    label: client.label,
    action: opts.uninstall ? 'uninstall' : 'install',
    scope,
    method: 'file',
    path,
    changed,
    wrote: false,
    dryRun: Boolean(opts.dryRun),
    diff: lineDiff(text, after, path),
    commands: [],
  };
  if (changed && !opts.dryRun) {
    result.backup = backup(path, opts.now ?? new Date());
    writeAtomic(path, after);
    result.wrote = true;
  }
  return result;
}

/** Claude Code through its own CLI, which knows where each scope lives and how to merge. */
function viaClaudeCli(
  client: JsonClient,
  claude: string,
  scope: Scope,
  server: ServerSpec | undefined,
  opts: InstallOptions,
): InstallResult {
  const e = opts.environment;
  const path = client.path(scope, e) as string;
  const readEntry = (): unknown => {
    const text = readIfExists(path);
    if (!text?.trim()) return undefined;
    let root: ReturnType<typeof parseJsonc>;
    try {
      root = parseJsonc(text, { comments: true });
    } catch (err) {
      throw parseFailure(
        path,
        err as Error,
        server ? jsonSnippet('mcpServers', client.entry(server, {})) : `Remove "${SERVER_NAME}".`,
      );
    }
    const servers = member(root, 'mcpServers');
    const found = servers?.value.kind === 'object' ? member(servers.value, SERVER_NAME) : undefined;
    return found ? toValue(found.value) : undefined;
  };
  const existing = readEntry();
  const commands: string[][] = [];
  const remove = ['mcp', 'remove', '--scope', scope, SERVER_NAME];
  let wantedEntry: Record<string, unknown> | undefined;
  if (!server) {
    if (existing !== undefined) commands.push(remove);
  } else {
    wantedEntry = client.entry(server, {});
    if (!entryMatches(wantedEntry, existing)) {
      if (existing !== undefined) commands.push(remove);
      if (server.kind === 'local') {
        const envFlags = Object.entries(server.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
        // The docs warn that --env directly before the name swallows it, so --scope and --transport sit between.
        commands.push([
          'mcp',
          'add',
          ...envFlags,
          '--scope',
          scope,
          '--transport',
          'stdio',
          SERVER_NAME,
          '--',
          server.command,
          ...server.args,
        ]);
      } else {
        const headers = (wantedEntry.headers ?? {}) as Record<string, string>;
        const headerFlags = Object.entries(headers).flatMap(([k, v]) => ['--header', `${k}: ${v}`]);
        commands.push(['mcp', 'add', '--scope', scope, '--transport', 'http', SERVER_NAME, server.url, ...headerFlags]);
      }
    }
  }
  const beforeEntry = existing === undefined ? '' : `${JSON.stringify({ [SERVER_NAME]: existing }, null, 2)}\n`;
  const result: InstallResult = {
    client: client.id,
    label: client.label,
    action: server ? 'install' : 'uninstall',
    scope,
    method: 'claude-cli',
    path,
    changed: commands.length > 0,
    wrote: false,
    dryRun: Boolean(opts.dryRun),
    diff: '',
    commands: commands.map((c) => ['claude', ...c]),
  };
  if (!result.changed) return result;
  if (opts.dryRun) {
    const afterEntry = wantedEntry ? `${JSON.stringify({ [SERVER_NAME]: wantedEntry }, null, 2)}\n` : '';
    result.diff = lineDiff(beforeEntry, afterEntry, `${path} (mcpServers)`);
    return result;
  }
  result.backup = backup(path, opts.now ?? new Date());
  for (const args of commands) {
    try {
      execFileSync(claude, args, { cwd: e.cwd, env: e.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      throw new Vid2ContextError('upstream', `claude ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`, {
        hint: `Run the command yourself to see the full error. A backup of the config is at ${result.backup ?? '(no file existed)'}.`,
        cause: err,
      });
    }
  }
  result.wrote = true;
  const now = readEntry();
  result.diff = lineDiff(
    beforeEntry,
    now === undefined ? '' : `${JSON.stringify({ [SERVER_NAME]: now }, null, 2)}\n`,
    `${path} (mcpServers)`,
  );
  return result;
}
