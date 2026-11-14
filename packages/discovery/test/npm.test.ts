import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_PACKAGE, MCP_PACKAGE, MCP_REGISTRY_NAME } from '../src/meta.ts';
import { buildPackage } from '../src/npm.ts';

// Builds the real bundles into a temp dir and runs them with plain node, the
// way `npx -y vid2context-mcp` will after publishing. No network is used:
// initialize and tools/list never reach a provider.
describe('npm packages', () => {
  let out: string;
  let mcpDir: string;
  let cliDir: string;

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'v2c-npm-'));
    mcpDir = await buildPackage(MCP_PACKAGE, out);
    cliDir = await buildPackage(CLI_PACKAGE, out);
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('writes a publishable manifest with the registry ownership marker', () => {
    const pkg = JSON.parse(readFileSync(join(mcpDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('vid2context-mcp');
    expect(pkg.mcpName).toBe(MCP_REGISTRY_NAME);
    expect(pkg.bin['vid2context-mcp']).toBe('./dist/vid2context-mcp.mjs');
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.private).toBeUndefined();
  });

  it('bundles an executable with a plain node shebang', () => {
    const file = join(mcpDir, 'dist/vid2context-mcp.mjs');
    expect(readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(statSync(file).mode & 0o111).not.toBe(0);
  });

  it('runs the CLI bundle', () => {
    const version = execFileSync(process.execPath, [join(cliDir, 'dist/vid2context.mjs'), '--version'], { encoding: 'utf8' });
    expect(version.trim()).toBe(CLI_PACKAGE.version);
  });

  it('serves MCP over stdio from the bundle', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(mcpDir, 'dist/vid2context-mcp.mjs')],
      cwd: out,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'discovery-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.version).toBe(MCP_PACKAGE.version);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('get_transcript');
    } finally {
      await client.close();
    }
  });
});
