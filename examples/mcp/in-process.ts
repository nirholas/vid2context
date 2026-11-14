/**
 * Drive the vid2context MCP server from an MCP client in one process: list
 * the tools, read an outline, then fetch one section. This is the same
 * server `npx vid2context-mcp` runs over stdio, connected through the SDK's
 * in-memory transport instead.
 *
 *   npx tsx examples/mcp/in-process.ts
 *
 * Offline: the server's library is seeded with a real recorded transcript,
 * so get_outline and get_section answer from it without fetching anything.
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStorage, type VideoContext } from '@vid2context/core';
import { createServer } from '@vid2context/mcp';
import { createNodeContext, createRegistry } from '@vid2context/registry/node';

const context: VideoContext = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url), 'utf8'),
);
const storage = new MemoryStorage();
await storage.putContext(context);

const server = createServer(createRegistry(), createNodeContext(), '0.1.0', { storage });
const client = new Client({ name: 'vid2context-example', version: '1.0.0' });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

const out = (s: string) => process.stdout.write(s);
const textOf = (result: Awaited<ReturnType<typeof client.callTool>>) =>
  (result.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const reading = ['get_transcript', 'get_outline', 'get_section', 'search_transcript'];
out(`Reading tools: ${reading.filter((n) => names.includes(n)).join(', ')}\n`);

const url = 'https://www.youtube.com/watch?v=cCPsdFdlshc';

// Structured tools return the same object as structuredContent and as JSON text.
const outline = await client.callTool({ name: 'get_outline', arguments: { url } });
const o = outline.structuredContent as {
  title: string;
  totalTokens: number;
  chapters: { index: number; start: string; tokens: number }[];
};
out(`\nget_outline: "${o.title}", ${o.totalTokens} tokens\n`);
for (const c of o.chapters) out(`  #${c.index} at ${c.start}: ${c.tokens} tokens\n`);

const section = await client.callTool({ name: 'get_section', arguments: { url, from: '4:35', to: '4:45', timestamps: true } });
out(`\nget_section from 4:35 to 4:45:\n${textOf(section)}\n`);

await client.close();
await server.close();
