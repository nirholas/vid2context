import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MemoryStorage } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { registerLibraryTools } from '../src/mcp.ts';
import { setup, ZOO } from './helpers.ts';

async function connect() {
  const { registry, ctx } = setup();
  const storage = new MemoryStorage();
  const server = new McpServer({ name: 'library-test', version: '0.0.0' });
  registerLibraryTools(server, { registry, ctx, storage });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: r.isError ?? false, json: JSON.parse(r.content[0]?.text ?? 'null') };
  };
  return { client, call, storage };
}

describe('collection tools', () => {
  it('registers the four contract tools with descriptions and schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_to_collection',
      'create_collection',
      'get_collection',
      'list_collections',
    ]);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    const add = tools.find((t) => t.name === 'add_to_collection');
    expect(add?.inputSchema.required?.sort()).toEqual(['collection', 'urls']);
  });

  it('creates a collection, adds a video, and reads it back', async () => {
    const { call } = await connect();
    const created = await call('create_collection', { name: 'Zoo', description: 'first upload' });
    expect(created.isError).toBe(false);
    const id = created.json.id as string;

    const added = await call('add_to_collection', { collection: id, urls: ['jNQXAC9IVRw', 'xxxxxxxxxxx'] });
    expect(added.isError).toBe(false);
    expect(added.json.collection.videoIds).toEqual([ZOO]);
    expect(added.json.summary.added).toEqual([
      { id: ZOO, title: 'Me at the zoo', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', origin: 'creator-captions' },
    ]);
    expect(added.json.summary.failed).toEqual([expect.objectContaining({ code: 'not-found', hint: expect.any(String) })]);

    const got = await call('get_collection', { collection: id });
    expect(got.json.videos).toEqual([expect.objectContaining({ id: ZOO, title: 'Me at the zoo' })]);

    const list = await call('list_collections', {});
    expect(list.json.collections).toEqual([expect.objectContaining({ id, name: 'Zoo', videos: 1, sources: [] })]);
  });

  it('returns errors as tool results with the standard body', async () => {
    const { call } = await connect();
    const missing = await call('get_collection', { collection: 'missing' });
    expect(missing.isError).toBe(true);
    expect(missing.json).toEqual(expect.objectContaining({ error: 'not-found', hint: expect.any(String), attempts: [] }));
    const badSource = await call('create_collection', { name: 'x', sources: ['https://www.youtube.com/watch?v=cCPsdFdlshc'] });
    expect(badSource.isError).toBe(true);
    expect(badSource.json.error).toBe('bad-request');
  });
});
