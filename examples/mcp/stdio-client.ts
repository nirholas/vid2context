/**
 * Connect to the vid2context MCP server over stdio, exactly as Claude Code,
 * Cursor or any other MCP client does: spawn the server, list its tools,
 * then call get_transcript and search_transcript.
 *
 *   npx tsx examples/mcp/stdio-client.ts [url]
 *
 * Live, no keys needed. Spawns this checkout's server; to use the published
 * package instead, set command: 'npx', args: ['-y', 'vid2context-mcp'].
 * Keys for the server go in `env` (it also reads ./.env).
 */
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const url = process.argv[2] ?? 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const transport = new StdioClientTransport({
  command: `${repo}node_modules/.bin/tsx`,
  args: [`${repo}packages/mcp/src/bin.ts`],
  // The SDK passes only a safe default environment; add any provider keys here.
  env: { ...getDefaultEnvironment(), ...(process.env.GROQ_API_KEY ? { GROQ_API_KEY: process.env.GROQ_API_KEY } : {}) },
  stderr: 'inherit', // the server logs to stderr; stdout carries the protocol
});
const client = new Client({ name: 'vid2context-example', version: '1.0.0' });
await client.connect(transport);

const out = (s: string) => process.stdout.write(s);
const textOf = (result: Awaited<ReturnType<typeof client.callTool>>) =>
  (result.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const info = client.getServerVersion();
const { tools } = await client.listTools();
out(`Connected to ${info?.name} ${info?.version}, ${tools.length} tools\n`);
const instructions = client.getInstructions();
if (instructions) out(`Server instructions start: "${instructions.split('\n')[0]}"\n`);

// Large results page on segment boundaries: pass maxTokens, then the next_cursor it returns.
const transcript = await client.callTool({ name: 'get_transcript', arguments: { url, timestamps: true, maxTokens: 4000 } });
out(`\nget_transcript:\n${textOf(transcript)}\n`);

// The video is now in the server's library, so search finds it.
const search = await client.callTool({ name: 'search_transcript', arguments: { query: 'elephants', urls: [url], limit: 1 } });
out(`\nsearch_transcript "elephants":\n${textOf(search)}\n`);

await client.close();
