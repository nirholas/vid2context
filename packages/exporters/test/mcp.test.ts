import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MemoryStorage, Registry, type Runtime, type VideoContext } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerExporterTools } from '../src/mcp.ts';

const fixture = (name: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${name}.json`, import.meta.url), 'utf8')) as VideoContext;

const zoo = fixture('youtube-jNQXAC9IVRw');
const gwagon = fixture('youtube-cCPsdFdlshc');
const fetch = replayFetch([]);
const storage = new MemoryStorage();
let collectionId = '';
let dir = '';

async function connect(runtime: Runtime, env: Record<string, string> = {}): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerExporterTools(server, { registry: new Registry([], 'node'), ctx: testContext({ fetch, env, runtime }), storage });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(b);
  return client;
}

function textOf(result: unknown): string {
  return ((result as { content: { text: string }[] }).content[0] as { text: string }).text;
}

beforeAll(async () => {
  await storage.putContext(zoo);
  await storage.putContext(gwagon);
  const c = await storage.createCollection({ name: 'G-Wagon buyer research' });
  collectionId = (await storage.addToCollection(c.id, [gwagon.metadata.ref.id, zoo.metadata.ref.id])).id;
  dir = mkdtempSync(join(tmpdir(), 'v2c-mcp-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('registerExporterTools', () => {
  it('registers export_obsidian only on Node, and export_notion everywhere', async () => {
    const node = await connect('node');
    expect((await node.listTools()).tools.map((t) => t.name).sort()).toEqual(['export_notion', 'export_obsidian']);
    const workers = await connect('workers');
    expect((await workers.listTools()).tools.map((t) => t.name)).toEqual(['export_notion']);
  });

  it('export_obsidian writes a collection into a vault and reports the paths', async () => {
    const client = await connect('node');
    const result = await client.callTool({ name: 'export_obsidian', arguments: { collection: collectionId, vaultPath: dir } });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result)) as { written: { path: string; status: string }[]; missing: string[] };
    expect(body.written.map((w) => w.path)).toEqual([
      join(dir, 'G-Wagon buyer research', 'Best & Worst G-Wagon Years - Reliability, Interiors & Engines Ranked!.md'),
      join(dir, 'G-Wagon buyer research', 'Me at the zoo.md'),
      join(dir, 'G-Wagon buyer research', 'G-Wagon buyer research.md'),
    ]);
    expect(readFileSync(join(dir, 'G-Wagon buyer research', 'Me at the zoo.md'), 'utf8')).toContain('# Me at the zoo');
    expect(fetch.calls).toHaveLength(0);
  });

  it('export_obsidian returns tool errors with a hint instead of throwing', async () => {
    const client = await connect('node');
    const result = await client.callTool({ name: 'export_obsidian', arguments: { vaultPath: dir } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ error: 'bad-request', hint: expect.any(String), attempts: [] });
  });

  it('export_notion explains a missing token', async () => {
    const client = await connect('workers');
    const result = await client.callTool({
      name: 'export_notion',
      arguments: { urls: ['https://www.youtube.com/watch?v=jNQXAC9IVRw'] },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ error: 'no-provider', message: 'NOTION_TOKEN is not set.' });
    expect(fetch.calls).toHaveLength(0);
  });
});
