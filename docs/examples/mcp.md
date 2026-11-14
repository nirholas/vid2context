# MCP examples

The MCP server is how agents such as Claude Code, Cursor, VS Code Copilot and ChatGPT read videos. To install it in a client, see [MCP](../guides/mcp.md); every tool and its arguments are in the [MCP tools contract](../contracts/mcp-tools.md). These examples are the other side: your own code acting as the MCP client, which is useful for testing, for scripted agents, and for seeing exactly what an agent receives.

## In one process

`createServer` builds the same server `npx vid2context-mcp` runs. The SDK's in-memory transport connects it to a client in the same process. The server's library is seeded with a recorded transcript, so this runs offline. Structured tools such as `get_outline` return an object in `structuredContent` as well as JSON text.

<!-- example: examples/mcp/in-process.ts -->
```ts
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
```

Output:

<!-- output: examples/mcp/in-process.ts -->
```text
Reading tools: get_transcript, get_outline, get_section, search_transcript

get_outline: "Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!", 4484 tokens
  #0 at 0:00: 1199 tokens
  #1 at 5:00: 1271 tokens
  #2 at 10:02: 1289 tokens
  #3 at 15:01: 725 tokens

get_section from 4:35 to 4:45:
Title: Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!
Channel: Alliance Motorworks
URL: https://www.youtube.com/watch?v=cCPsdFdlshc
Duration: 18:04
Transcript: auto-captions, en (youtube-captions)

Section: 4:35 to 4:45, about 90 tokens

[4:33] of the 55 ran to 03 and 04 just two
[4:35] years the compressor motor that came out
[4:37] in 05 that's where things got exciting
[4:39] you had a 490 horsepower compressor
[4:41] motor which is a Supercharged motor so
[4:43] when you see compressor that means

```

The text an agent gets from `get_section` starts with a short header (title, channel, URL, duration, where the transcript came from) and the size of the section, so it can plan what to read next.

## Over stdio

This is exactly what an agent does: spawn the server as a child process and speak MCP over its stdin and stdout. The server logs to stderr only, so stdout carries nothing but the protocol. The SDK starts the child with a minimal environment, so pass any provider keys in `env`.

<!-- example: examples/mcp/stdio-client.ts -->
```ts
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
```

Recorded run from an empty directory with no keys. The header says the transcript came from speech-to-text (`stt`, by the keyless Whisper rung) rather than captions: YouTube was refusing caption requests from this cloud VM at the time, so the chain fell through.

```text
Connected to vid2context 0.1.1, 28 tools
Server instructions start: "vid2context turns videos into context you can cite. Speech is about 12k tokens per hour of video."

get_transcript:
Title: Me at the zoo
Channel: jawed
URL: https://www.youtube.com/watch?v=jNQXAC9IVRw
Duration: 0:19
Transcript: stt, en (stt/ovh/whisper-large-v3-turbo)
Chapters: 0:00 Intro | 0:05 The cool thing | 0:17 End

[0:01] Alright, so here we are, one of the elephants, and the cool thing about these guys is that they have really, really
[0:16] And that's pretty much all there is to say.


search_transcript "elephants":
1. Me at the zoo [0:01-0:14] (chapter: Intro)
   https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s
   Alright, so here we are, one of the **elephants**, and the cool thing about these guys is that they have really, really

(searched 1 videos with keyword (storage) + vector (embed/ovh/bge-m3))
```

The search ran both sides: keyword search in the SQLite library the server created in the working directory (`.vid2context/library.db`), and vector search with the keyless `bge-m3` embedding model. The status line under the hits says which sides ran and why one was skipped, so an agent can tell a weak search from an empty one.
