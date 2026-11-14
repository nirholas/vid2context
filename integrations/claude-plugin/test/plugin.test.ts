import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_COMMAND, MCP_PACKAGE } from '@vid2context/discovery';
import { describe, expect, it } from 'vitest';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PLUGIN, '..', '..');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

/** Front matter as flat key: value pairs (the skill uses only single-line scalars). */
function frontMatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m?.[1]) throw new Error('SKILL.md has no front matter');
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line);
    if (!kv?.[1]) throw new Error(`Unexpected front matter line: ${line}`);
    out[kv[1]] = kv[2] ?? '';
  }
  return out;
}

describe('Claude Code plugin', () => {
  const manifest = json(join(PLUGIN, '.claude-plugin', 'plugin.json'));

  it('plugin.json has the fields Claude Code and the validator expect', () => {
    expect(manifest.name).toBe('vid2context');
    expect(manifest.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(manifest.version).toBe(MCP_PACKAGE.version);
    expect(typeof manifest.description).toBe('string');
    expect(manifest.author).toEqual({ name: 'nirholas', url: 'https://github.com/nirholas' });
    expect(() => new URL(manifest.homepage as string)).not.toThrow();
  });

  it('runs the published MCP package, never a path into a clone', () => {
    expect(manifest.mcpServers).toEqual({ vid2context: { command: MCP_COMMAND.command, args: [...MCP_COMMAND.args] } });
  });

  it('the skill has a name matching its folder and a description that says when to use it', () => {
    const skill = readFileSync(join(PLUGIN, 'skills', 'vid2context', 'SKILL.md'), 'utf8');
    const fm = frontMatter(skill);
    expect(fm.name).toBe('vid2context');
    expect(fm.description?.length).toBeGreaterThan(50);
    expect(fm.description?.length).toBeLessThanOrEqual(1024);
    expect(fm.description).toMatch(/Use whenever/);
  });

  it('every tool and prompt the skill names is in the MCP tools contract', () => {
    const skill = readFileSync(join(PLUGIN, 'skills', 'vid2context', 'SKILL.md'), 'utf8');
    const contract = readFileSync(join(REPO, 'docs', 'contracts', 'mcp-tools.md'), 'utf8');
    const named = new Set([...skill.matchAll(/`([a-z]+(?:_[a-z]+)+|brief)`/g)].map((m) => m[1] as string));
    for (const name of named) {
      expect(contract, `${name} is named in SKILL.md`).toContain(`\`${name}\``);
    }
    expect(named.has('get_outline') && named.has('get_section') && named.has('search_transcript')).toBe(true);
  });
});

describe('marketplace', () => {
  const market = json(join(REPO, '.claude-plugin', 'marketplace.json'));

  it('lists the plugin with a relative source that exists', () => {
    expect(market.name).toBe('vid2context');
    expect(market.owner).toEqual({ name: 'nirholas' });
    const plugins = market.plugins as { name: string; source: string; description: string }[];
    expect(plugins).toHaveLength(1);
    const [entry] = plugins;
    expect(entry?.name).toBe('vid2context');
    expect(entry?.source).toBe('./integrations/claude-plugin');
    expect(entry?.source).not.toContain('..');
    expect(existsSync(join(REPO, entry?.source ?? '', '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(json(join(REPO, entry?.source ?? '', '.claude-plugin', 'plugin.json')).name).toBe(entry?.name);
  });
});
