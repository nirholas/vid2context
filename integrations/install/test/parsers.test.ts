import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listClients, parseArgs } from '../src/bin.ts';
import { chooseServerCommand, REPO_ROOT, splitCommandLine } from '../src/command.ts';
import { lineDiff } from '../src/diff.ts';
import { member, parseJsonc, removeMember, setMember, toValue } from '../src/jsonc.ts';
import { findTable, parseToml, removeTable, setTable } from '../src/toml.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

describe('jsonc', () => {
  it('parses every JSON fixture to the same value JSON.parse gives (or with comments, after stripping them)', () => {
    for (const dir of readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const f of readdirSync(join(FIXTURES, dir.name)).filter((n) => n.endsWith('.json'))) {
        const text = fixture(`${dir.name}/${f}`);
        const stripped = text.replace(/^\s*\/\/.*$/gm, '');
        expect(toValue(parseJsonc(text, { comments: true }))).toEqual(JSON.parse(stripped));
      }
    }
  });

  it('rejects comments when they are not allowed and reports the position', () => {
    expect(() => parseJsonc(fixture('cursor/docs-remote-commented.json'), { comments: false })).toThrow(/line 1, column 1/);
  });

  it('appends and removes as exact inverses, with CRLF and tabs preserved', () => {
    const text = fixture('claude-code/docs-stdio.mcp.json').replace(/ {2}/g, '\t').replace(/\n/g, '\r\n');
    const servers = member(parseJsonc(text, { comments: true }), 'mcpServers')?.value;
    if (!servers) throw new Error('fixture has mcpServers');
    const added = setMember(text, servers, 'vid2context', { command: 'npx', args: ['-y', 'vid2context-mcp'] });
    expect(added).toContain('\r\n\t\t"vid2context": {\r\n\t\t\t"command": "npx",');
    expect(added.includes('\n') && !/[^\r]\n/.test(added)).toBe(true);
    const again = member(parseJsonc(added, { comments: true }), 'mcpServers')?.value;
    if (!again) throw new Error('still has mcpServers');
    expect(removeMember(added, again, 'vid2context')).toBe(text);
  });

  it('removes a first member and keeps a JSONC trailing comma intact', () => {
    const text = '{\n  // servers\n  "a": 1,\n  "b": 2,\n}\n';
    const root = parseJsonc(text, { comments: true });
    expect(removeMember(text, root, 'a')).toBe('{\n  // servers\n  "b": 2,\n}\n');
    const added = setMember(text, root, 'c', 3);
    expect(added).toBe('{\n  // servers\n  "a": 1,\n  "b": 2,\n  "c": 3,\n}\n');
    expect(removeMember(added, parseJsonc(added, { comments: true }), 'c')).toBe(text);
  });

  it('inserts into an empty object and removes back to empty', () => {
    const text = '{"mcpServers": {}}';
    const servers = member(parseJsonc(text, { comments: true }), 'mcpServers')?.value;
    if (!servers) throw new Error('has mcpServers');
    const added = setMember(text, servers, 'x', { a: 1 });
    expect(JSON.parse(added)).toEqual({ mcpServers: { x: { a: 1 } } });
    const after = member(parseJsonc(added, { comments: true }), 'mcpServers')?.value;
    if (!after) throw new Error('has mcpServers');
    expect(removeMember(added, after, 'x')).toBe(text);
  });
});

describe('toml', () => {
  it('parses the Codex fixtures', () => {
    expect(parseToml(fixture('codex/docs-mcp.toml'))).toEqual({
      mcp_servers: {
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          env_vars: ['LOCAL_TOKEN'],
          env: { MY_ENV_VAR: 'MY_ENV_VALUE' },
        },
        figma: {
          url: 'https://mcp.figma.com/mcp',
          bearer_token_env_var: 'FIGMA_OAUTH_TOKEN',
          http_headers: { 'X-Figma-Region': 'us-east-1' },
        },
      },
    });
    const commented = parseToml(fixture('codex/docs-commented.toml'));
    expect(commented.approval_policy).toBe('on-request');
    expect(commented.sandbox_workspace_write).toEqual({
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: false,
      writable_roots: ['/Users/YOU/.pyenv/shims'],
      network_access: false,
    });
  });

  it('rejects invalid TOML with a line number', () => {
    expect(() => parseToml('a = 1\nb = \n')).toThrow(/line 2/);
    expect(() => parseToml('a = 1\na = 2\n')).toThrow(/Duplicate/);
    expect(() => parseToml('[t]\n[t]\n')).toThrow(/defined twice/);
  });

  it('replaces a table in the middle, sub-tables included, without touching its neighbours', () => {
    const text = fixture('codex/docs-mcp.toml');
    const replaced = setTable(text, ['mcp_servers', 'context7'], { command: 'node' });
    expect(replaced).toBe(`[mcp_servers.context7]\ncommand = "node"\n\n${text.slice(text.indexOf('[mcp_servers.figma]'))}`);
    expect(removeTable(text, ['mcp_servers', 'context7'])).toBe(text.slice(text.indexOf('[mcp_servers.figma]')));
  });

  it('ignores header-like lines inside multi-line strings', () => {
    const text = 'note = """\n[mcp_servers.vid2context]\n"""\n';
    expect(parseToml(text)).toEqual({ note: '[mcp_servers.vid2context]\n' });
    expect(findTable(text, ['mcp_servers', 'vid2context'])).toBeUndefined();
  });

  it('writes env as a sub-table, the way codex mcp add does', () => {
    const out = setTable('', ['mcp_servers', 'vid2context'], {
      command: 'npx',
      args: ['-y', 'vid2context-mcp'],
      env: { A: 'b' },
    });
    expect(out).toBe(
      '[mcp_servers.vid2context]\ncommand = "npx"\nargs = ["-y", "vid2context-mcp"]\n\n[mcp_servers.vid2context.env]\nA = "b"\n',
    );
    expect(parseToml(out)).toEqual({
      mcp_servers: { vid2context: { command: 'npx', args: ['-y', 'vid2context-mcp'], env: { A: 'b' } } },
    });
  });
});

describe('server command', () => {
  it('splits a quoted command line', () => {
    expect(splitCommandLine(`node "/path with space/bin.js" --flag ''`)).toEqual([
      'node',
      '/path with space/bin.js',
      '--flag',
      '',
    ]);
  });

  it('prefers --command, then --from-source, then a global bin, then npx', () => {
    expect(chooseServerCommand({ command: 'vid2context-mcp --x', env: {}, platform: 'linux' })).toMatchObject({
      command: 'vid2context-mcp',
      args: ['--x'],
    });
    const source = chooseServerCommand({ fromSource: true, env: {}, platform: 'linux' });
    expect(source.args.at(-1)).toBe(join(REPO_ROOT, 'packages', 'mcp', 'src', 'bin.ts'));
    expect(chooseServerCommand({ env: { PATH: '' }, platform: 'linux' })).toMatchObject({
      command: 'npx',
      args: ['-y', 'vid2context-mcp'],
    });

    const dir = mkdtempSync(join(tmpdir(), 'v2c-bin-'));
    try {
      const bin = join(dir, 'global', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'vid2context-mcp'), '#!/bin/sh\n');
      chmodSync(join(bin, 'vid2context-mcp'), 0o755);
      expect(chooseServerCommand({ env: { PATH: bin }, platform: 'linux' })).toMatchObject({
        command: 'vid2context-mcp',
        args: [],
      });
      // node_modules/.bin on PATH (npx, npm run) does not count as a global install.
      const local = join(dir, 'node_modules', '.bin');
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, 'vid2context-mcp'), '#!/bin/sh\n');
      expect(chooseServerCommand({ env: { PATH: local }, platform: 'linux' }).command).toBe('npx');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('arguments', () => {
  it('parses the full flag set', () => {
    expect(parseArgs(['cursor', '--scope', 'project', '--env', 'A=b=c', '--dry-run', '--json'])).toMatchObject({
      client: 'cursor',
      scope: 'project',
      env: { A: 'b=c' },
      dryRun: true,
      json: true,
    });
    expect(parseArgs(['codex', '--remote', 'https://h/mcp', '--token-env', 'T'])).toMatchObject({
      remote: 'https://h/mcp',
      tokenEnv: 'T',
    });
  });

  it('rejects contradictory or malformed flags', () => {
    expect(() => parseArgs(['cursor', '--token', 'x'])).toThrow(/--remote/);
    expect(() => parseArgs(['cursor', '--remote', 'https://h', '--command', 'x'])).toThrow(/local server/);
    expect(() => parseArgs(['cursor', '--remote', 'ftp://h'])).toThrow(/http/);
    expect(() => parseArgs(['cursor', '--scope', 'global'])).toThrow(/scope/);
    expect(() => parseArgs(['cursor', '--env', 'NOEQUALS'])).toThrow(/KEY=VALUE/);
    expect(() => parseArgs(['cursor', '--bogus'])).toThrow(/Unknown option/);
  });

  it('list covers every client with a docs link and verification date', () => {
    const rows = listClients({ home: '/h', cwd: '/p', platform: 'linux', env: {} });
    expect(rows.map((r) => r.id)).toEqual(['claude-code', 'claude-desktop', 'cursor', 'vscode', 'codex', 'gemini-cli']);
    for (const r of rows) {
      expect(r.docs.length).toBeGreaterThan(0);
      for (const d of r.docs) expect(d).toMatchObject({ url: expect.stringMatching(/^https:\/\//), verified: '2026-11-14' });
    }
  });
});

describe('diff', () => {
  it('marks added and removed lines', () => {
    expect(lineDiff('a\nb\n', 'a\nc\n', 'f')).toBe('--- f\n+++ f\n  a\n+ c\n- b\n');
    expect(lineDiff('same', 'same', 'f')).toBe('');
  });
});
