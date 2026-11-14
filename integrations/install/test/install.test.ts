import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vid2ContextError } from '@vid2context/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Environment, getClient, type LocalServer, type RemoteServer, type Scope } from '../src/clients.ts';
import { install } from '../src/install.ts';
import { parseJsonc, toValue } from '../src/jsonc.ts';
import { parseToml } from '../src/toml.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

const LOCAL: LocalServer = { kind: 'local', command: 'npx', args: ['-y', 'vid2context-mcp'], env: {} };
const REMOTE: RemoteServer = { kind: 'remote', url: 'https://mcp.example.org/mcp', token: 'abc123' };

let root: string;
let env: Environment;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'v2c-install-'));
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'project'));
  // An empty PATH: no claude CLI and no global vid2context-mcp, so every client takes the file path.
  env = { home: join(root, 'home'), cwd: join(root, 'project'), platform: 'linux', env: { PATH: '' } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Case {
  client: string;
  scope: Scope;
  legacy?: boolean;
  /** Path relative to the temp root. */
  file: string;
  format: 'json' | 'toml';
  key: string[];
  fixture: string;
  local: Record<string, unknown>;
  remote?: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    client: 'claude-code',
    scope: 'project',
    file: 'project/.mcp.json',
    format: 'json',
    key: ['mcpServers'],
    fixture: 'claude-code/cli-project.mcp.json',
    local: { type: 'stdio', command: 'npx', args: ['-y', 'vid2context-mcp'] },
    remote: { type: 'http', url: 'https://mcp.example.org/mcp', headers: { Authorization: 'Bearer abc123' } },
  },
  {
    client: 'claude-desktop',
    scope: 'user',
    file: 'home/.config/Claude/claude_desktop_config.json',
    format: 'json',
    key: ['mcpServers'],
    fixture: 'claude-desktop/docs-macos.json',
    local: { command: 'npx', args: ['-y', 'vid2context-mcp'] },
  },
  {
    client: 'cursor',
    scope: 'user',
    file: 'home/.cursor/mcp.json',
    format: 'json',
    key: ['mcpServers'],
    fixture: 'cursor/docs-remote-commented.json',
    local: { type: 'stdio', command: 'npx', args: ['-y', 'vid2context-mcp'] },
    remote: { url: 'https://mcp.example.org/mcp', headers: { Authorization: 'Bearer abc123' } },
  },
  {
    client: 'cursor',
    scope: 'project',
    file: 'project/.cursor/mcp.json',
    format: 'json',
    key: ['mcpServers'],
    fixture: 'cursor/docs-stdio.json',
    local: { type: 'stdio', command: 'npx', args: ['-y', 'vid2context-mcp'] },
  },
  {
    client: 'vscode',
    scope: 'user',
    file: 'home/.copilot/mcp-config.json',
    format: 'json',
    key: ['mcpServers'],
    fixture: 'vscode/docs-portable.json',
    local: { type: 'stdio', command: 'npx', args: ['-y', 'vid2context-mcp'], tools: ['*'] },
    remote: { type: 'http', url: 'https://mcp.example.org/mcp', headers: { Authorization: 'Bearer abc123' }, tools: ['*'] },
  },
  {
    client: 'vscode',
    scope: 'project',
    legacy: true,
    file: 'project/.vscode/mcp.json',
    format: 'json',
    key: ['servers'],
    fixture: 'vscode/docs-legacy.json',
    local: { type: 'stdio', command: 'npx', args: ['-y', 'vid2context-mcp'] },
    remote: { type: 'http', url: 'https://mcp.example.org/mcp', headers: { Authorization: 'Bearer abc123' } },
  },
  {
    client: 'codex',
    scope: 'user',
    file: 'home/.codex/config.toml',
    format: 'toml',
    key: ['mcp_servers'],
    fixture: 'codex/cli-generated.toml',
    local: { command: 'npx', args: ['-y', 'vid2context-mcp'] },
    remote: { url: 'https://mcp.example.org/mcp', http_headers: { Authorization: 'Bearer abc123' } },
  },
  {
    client: 'codex',
    scope: 'project',
    file: 'project/.codex/config.toml',
    format: 'toml',
    key: ['mcp_servers'],
    fixture: 'codex/docs-commented.toml',
    local: { command: 'npx', args: ['-y', 'vid2context-mcp'] },
  },
  {
    client: 'gemini-cli',
    scope: 'user',
    file: 'home/.gemini/settings.json',
    format: 'json',
    key: ['mcpServers'],
    fixture: 'gemini-cli/docs-settings.json',
    local: { command: 'npx', args: ['-y', 'vid2context-mcp'] },
    remote: { httpUrl: 'https://mcp.example.org/mcp', headers: { Authorization: 'Bearer abc123' } },
  },
  {
    client: 'gemini-cli',
    scope: 'project',
    file: 'project/.gemini/settings.json',
    format: 'json',
    key: ['mcpServers'],
    fixture: 'gemini-cli/cli-user.json',
    local: { command: 'npx', args: ['-y', 'vid2context-mcp'] },
  },
];

const parse = (c: Case, text: string): Record<string, unknown> =>
  c.format === 'toml' ? parseToml(text) : (toValue(parseJsonc(text, { comments: true })) as Record<string, unknown>);

const entryOf = (c: Case, text: string): unknown => {
  const servers = c.key.reduce<unknown>((t, k) => (t as Record<string, unknown> | undefined)?.[k], parse(c, text));
  return (servers as Record<string, unknown> | undefined)?.vid2context;
};

/** The parsed document with the vid2context entry taken out (and its server map, when `original` had none). */
const withoutEntry = (c: Case, text: string, original: string): unknown => {
  const doc = structuredClone(parse(c, text));
  const parent = c.key.slice(0, -1).reduce<unknown>((t, k) => (t as Record<string, unknown>)[k], doc) as Record<string, unknown>;
  const last = c.key.at(-1) as string;
  const servers = parent[last] as Record<string, unknown>;
  delete servers.vid2context;
  if (Object.keys(servers).length === 0 && !(last in parse(c, original))) delete parent[last];
  return doc;
};

const backups = (path: string) => (existsSync(dirname(path)) ? readdirSync(dirname(path)).filter((f) => f.includes('.vid2context-backup-')) : []);

describe.each(CASES)('$client ($scope$legacy)', (c) => {
  const run = (opts: { server?: LocalServer | RemoteServer; uninstall?: boolean; dryRun?: boolean } = {}) =>
    install({
      client: c.client,
      scope: c.scope,
      legacy: c.legacy,
      server: opts.uninstall ? undefined : (opts.server ?? LOCAL),
      uninstall: opts.uninstall,
      dryRun: opts.dryRun,
      environment: env,
      now: new Date('2026-11-14T17:00:00Z'),
    });
  const path = () => join(root, c.file);
  const seed = () => {
    mkdirSync(dirname(path()), { recursive: true });
    writeFileSync(path(), fixture(c.fixture));
  };

  it('installs into a missing file', () => {
    const result = run();
    expect(result.path).toBe(path());
    expect(result.changed).toBe(true);
    expect(result.wrote).toBe(true);
    expect(result.backup).toBeUndefined();
    expect(entryOf(c, readFileSync(path(), 'utf8'))).toEqual(c.local);
  });

  it('merges into a file with other servers and unknown keys, keeping them', () => {
    seed();
    const before = fixture(c.fixture);
    run();
    const after = readFileSync(path(), 'utf8');
    expect(entryOf(c, after)).toEqual(c.local);
    expect(withoutEntry(c, after, before)).toEqual(parse(c, before));
    // Comments in the original survive.
    for (const line of before.split('\n').filter((l) => /^\s*(\/\/|#)/.test(l))) expect(after).toContain(line);
  });

  it('writes a timestamped backup with the original content', () => {
    seed();
    const result = run();
    expect(result.backup).toBe(`${path()}.vid2context-backup-20261114T170000Z`);
    expect(readFileSync(result.backup as string, 'utf8')).toBe(fixture(c.fixture));
  });

  it('is idempotent: a second run changes nothing and makes no backup', () => {
    seed();
    run();
    const once = readFileSync(path(), 'utf8');
    const count = backups(path()).length;
    const second = run();
    expect(second.changed).toBe(false);
    expect(second.wrote).toBe(false);
    expect(readFileSync(path(), 'utf8')).toBe(once);
    expect(backups(path()).length).toBe(count);
  });

  it('uninstall leaves the rest of the file byte-identical', () => {
    seed();
    run();
    const result = run({ uninstall: true });
    expect(result.changed).toBe(true);
    expect(readFileSync(path(), 'utf8')).toBe(fixture(c.fixture));
    expect(run({ uninstall: true }).changed).toBe(false);
  });

  it('never touches a file that fails to parse', () => {
    const original = fixture(c.fixture);
    // Cut the real file inside an unterminated string or table header so it no longer parses.
    const broken = c.format === 'toml' ? `${original}\n[mcp_servers.broken\n` : original.slice(0, original.indexOf('{', 1) + 3);
    mkdirSync(dirname(path()), { recursive: true });
    writeFileSync(path(), broken);
    let error: unknown;
    try {
      run();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Vid2ContextError);
    expect((error as Vid2ContextError).code).toBe('bad-request');
    expect((error as Vid2ContextError).hint).toContain('vid2context');
    expect(readFileSync(path(), 'utf8')).toBe(broken);
    expect(backups(path())).toEqual([]);
  });

  it('dry run prints a diff and writes nothing', () => {
    seed();
    const result = run({ dryRun: true });
    expect(result.changed).toBe(true);
    expect(result.wrote).toBe(false);
    expect(result.diff).toMatch(/^\+ .*vid2context/m);
    expect(readFileSync(path(), 'utf8')).toBe(fixture(c.fixture));
    expect(backups(path())).toEqual([]);
    const fresh = install({ client: c.client, scope: c.scope, legacy: c.legacy, server: LOCAL, dryRun: true, environment: { ...env, cwd: join(root, 'nowhere'), home: join(root, 'nohome') } });
    expect(fresh.diff.startsWith('--- /dev/null')).toBe(true);
    expect(existsSync(fresh.path)).toBe(false);
  });

  it('writes the remote shape, or explains why it cannot', () => {
    seed();
    if (!c.remote) {
      if (c.client === 'claude-desktop') {
        expect(() => run({ server: REMOTE })).toThrow(/Connectors|remote/);
        expect(readFileSync(path(), 'utf8')).toBe(fixture(c.fixture));
      }
      return;
    }
    run({ server: REMOTE });
    expect(entryOf(c, readFileSync(path(), 'utf8'))).toEqual(c.remote);
    // Switching back to local replaces the whole entry.
    run();
    expect(entryOf(c, readFileSync(path(), 'utf8'))).toEqual(c.local);
  });
});

describe('client specifics', () => {
  it('env vars are written only when passed', () => {
    const r = install({ client: 'cursor', server: { ...LOCAL, env: { OLLAMA_BASE_URL: 'http://localhost:11434/v1' } }, environment: env });
    expect(entryOf(CASES[2] as Case, readFileSync(r.path, 'utf8'))).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'vid2context-mcp'],
      env: { OLLAMA_BASE_URL: 'http://localhost:11434/v1' },
    });
  });

  it('--token-env references the variable in each client syntax', () => {
    const remote: RemoteServer = { kind: 'remote', url: 'https://mcp.example.org/mcp', tokenEnv: 'V2C_TOKEN' };
    const header = (client: string, legacy?: boolean) => {
      const c = getClient(client);
      if (c.format !== 'json') throw new Error('json client expected');
      return (c.entry(remote, { legacy }) as { headers: Record<string, string> }).headers.Authorization;
    };
    expect(header('claude-code')).toBe('Bearer ${V2C_TOKEN}');
    expect(header('cursor')).toBe('Bearer ${env:V2C_TOKEN}');
    expect(header('vscode')).toBe('Bearer ${V2C_TOKEN}');
    expect(header('vscode', true)).toBe('Bearer ${env:V2C_TOKEN}');
    const codex = getClient('codex');
    expect(codex.format === 'toml' && codex.entry(remote)).toEqual({ url: 'https://mcp.example.org/mcp', bearer_token_env_var: 'V2C_TOKEN' });
    expect(() => header('gemini-cli')).toThrow(/Gemini CLI has no documented way/);
  });

  it('claude-code user scope without the CLI refuses instead of editing ~/.claude.json', () => {
    expect(() => install({ client: 'claude-code', scope: 'user', server: LOCAL, environment: env })).toThrow(/claude CLI/);
    expect(existsSync(join(env.home, '.claude.json'))).toBe(false);
  });

  it('a Claude Code entry already in a shared .mcp.json with extra fields counts as installed', () => {
    // VS Code's portable entry adds tools: ["*"]; Claude Code must not strip it.
    install({ client: 'vscode', scope: 'project', server: LOCAL, environment: env });
    const r = install({ client: 'claude-code', scope: 'project', server: LOCAL, environment: env });
    expect(r.changed).toBe(false);
  });

  it('a Codex entry defined inline is refused with a snippet', () => {
    const path = join(env.home, '.codex', 'config.toml');
    mkdirSync(dirname(path), { recursive: true });
    const inline = `${fixture('codex/cli-generated.toml')}\n[mcp_servers]\nvid2context = { command = "old" }\n`;
    writeFileSync(path, inline);
    expect(() => install({ client: 'codex', server: LOCAL, environment: env })).toThrow(/inline/);
    expect(readFileSync(path, 'utf8')).toBe(inline);
  });

  it('Claude Desktop paths follow the platform', () => {
    const c = getClient('claude-desktop');
    expect(c.path('user', { ...env, platform: 'darwin', home: '/Users/u' })).toBe('/Users/u/Library/Application Support/Claude/claude_desktop_config.json');
    expect(c.path('user', { ...env, platform: 'win32', env: { APPDATA: 'C:/Users/u/AppData/Roaming' } })).toContain('Claude');
    expect(c.path('user', env)).toBe(join(env.home, '.config', 'Claude', 'claude_desktop_config.json'));
  });

  it('CODEX_HOME and COPILOT_HOME move the user configs', () => {
    expect(getClient('codex').path('user', { ...env, env: { CODEX_HOME: '/x/codex' } })).toBe('/x/codex/config.toml');
    expect(getClient('vscode').path('user', { ...env, env: { COPILOT_HOME: '/x/copilot' } })).toBe('/x/copilot/mcp-config.json');
  });

  it('rejects unknown clients and scopes with a hint', () => {
    expect(() => install({ client: 'windsurf', server: LOCAL, environment: env })).toThrow(/Unknown client/);
    expect(() => install({ client: 'claude-desktop', scope: 'project', server: LOCAL, environment: env })).toThrow(/no project scope/);
    expect(() => install({ client: 'cursor', legacy: true, server: LOCAL, environment: env })).toThrow(/--legacy/);
  });
});
