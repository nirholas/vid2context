/**
 * LIVE=1 only: installs into a temp Claude Code project through the real
 * claude CLI and reads it back with `claude mcp get` and `claude mcp list`.
 * Needs `claude` on PATH (outside node_modules/.bin).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findOnPath } from '../src/command.ts';
import { install } from '../src/install.ts';

const claude = findOnPath('claude', process.env, process.platform);

describe.skipIf(!process.env.LIVE)('claude CLI (live)', () => {
  it('installs, reads back and uninstalls in a temp project', () => {
    if (!claude) throw new Error('LIVE needs the claude CLI on PATH');
    const root = mkdtempSync(join(tmpdir(), 'v2c-live-'));
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    mkdirSync(home);
    mkdirSync(cwd);
    const env = { ...process.env, HOME: home };
    const environment = { home, cwd, platform: process.platform, env };
    const server = { kind: 'local' as const, command: 'npx', args: ['-y', 'vid2context-mcp'], env: {} };
    try {
      const first = install({ client: 'claude-code', scope: 'project', server, environment });
      expect(first.method).toBe('claude-cli');
      expect(first.wrote).toBe(true);
      expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')).mcpServers.vid2context).toMatchObject({
        command: 'npx',
        args: ['-y', 'vid2context-mcp'],
      });
      const got = execFileSync(claude, ['mcp', 'get', 'vid2context'], { cwd, env, encoding: 'utf8' });
      expect(got).toContain('npx');
      expect(execFileSync(claude, ['mcp', 'list'], { cwd, env, encoding: 'utf8' })).toContain('vid2context');
      expect(install({ client: 'claude-code', scope: 'project', server, environment }).changed).toBe(false);
      const removed = install({ client: 'claude-code', scope: 'project', uninstall: true, environment });
      expect(removed.commands).toEqual([['claude', 'mcp', 'remove', '--scope', 'project', 'vid2context']]);
      expect(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')).mcpServers.vid2context).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
