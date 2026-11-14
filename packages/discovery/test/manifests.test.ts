import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeCommand, cursorDeeplink, cursorInstallUrl, vscodeDeeplink, vscodeInstallUrl } from '../src/install.ts';
import { geminiExtensionJson, rootFiles, serverJson } from '../src/manifests.ts';
import { ENV_VARS, MCP_PACKAGE, MCP_REGISTRY_NAME, PACKAGES } from '../src/meta.ts';
import { packageJson, ROOT } from '../src/npm.ts';

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('root manifests', () => {
  // JSON is compared parsed because Biome reformats the committed copies.
  for (const [path, expected] of Object.entries(rootFiles())) {
    it(`${path} matches the generator (run npm run discovery:gen if this fails)`, () => {
      if (path.endsWith('.json')) expect(JSON.parse(read(path))).toEqual(JSON.parse(expected));
      else expect(read(path)).toBe(expected);
    });
  }
});

describe('MCP Registry rules', () => {
  const server = serverJson();

  it('uses a valid name, a short description and exact versions', () => {
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
    expect(server.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(server.packages[0]?.version).toBe(server.version);
    for (const icon of server.icons) expect(icon.src.length).toBeLessThanOrEqual(255);
  });

  it('matches the npm ownership marker on the published package', () => {
    expect(packageJson(MCP_PACKAGE).mcpName).toBe(MCP_REGISTRY_NAME);
    expect(server.name).toBe(MCP_REGISTRY_NAME);
    expect(server.packages[0]?.identifier).toBe(MCP_PACKAGE.name);
  });

  it('marks every key optional, since the server works with none', () => {
    for (const v of server.packages[0]?.environmentVariables ?? []) expect(v.isRequired).toBe(false);
  });
});

describe('versions', () => {
  it('follows the workspace package versions', () => {
    for (const pkg of PACKAGES) {
      const source = JSON.parse(read(`${pkg.directory}/package.json`));
      expect(pkg.version).toBe(source.version);
    }
    expect(geminiExtensionJson().version).toBe(MCP_PACKAGE.version);
  });
});

describe('env vars', () => {
  it('only surfaces variables documented in .env.example', () => {
    const example = read('.env.example');
    for (const v of ENV_VARS) expect(example).toContain(`${v.name}=`);
  });
});

describe('install links', () => {
  it('encodes the same command in every client format', () => {
    expect(claudeCodeCommand.endsWith('-- npx -y vid2context-mcp')).toBe(true);
    const vscode = JSON.parse(decodeURIComponent(vscodeDeeplink().slice('vscode:mcp/install?'.length)));
    expect(vscode).toEqual({ name: 'vid2context', command: 'npx', args: ['-y', 'vid2context-mcp'] });
    expect(new URL(vscodeInstallUrl()).searchParams.get('url')).toBe(vscodeDeeplink());
    const config = new URL(cursorDeeplink()).searchParams.get('config') ?? '';
    expect(JSON.parse(atob(config))).toEqual({ command: 'npx', args: ['-y', 'vid2context-mcp'] });
  });

  it('keeps the README install section in sync', () => {
    const readme = read('README.md');
    expect(readme).toContain(claudeCodeCommand);
    expect(readme).toContain(vscodeInstallUrl());
    expect(readme).toContain(vscodeInstallUrl(true));
    expect(readme).toContain(cursorInstallUrl());
  });
});
