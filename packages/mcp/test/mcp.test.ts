import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { createRegistry } from '@vid2context/registry/node';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.ts';

// Real recordings from providers/youtube/test/fixtures.
const root = join(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(join(root, 'providers/youtube/test/fixtures', p), 'utf8');

async function connect() {
  const fetch = replayFetch([
    {
      method: 'POST',
      url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      response: (call) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        return { body: read(`player-${videoId === 'jNQXAC9IVRw' ? videoId : 'unavailable'}.json`) };
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en/, response: { body: read('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
  ]);
  const server = createServer(createRegistry(), testContext({ fetch }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

describe('MCP tools', () => {
  it('lists get_transcript and get_metadata', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_metadata', 'get_transcript']);
  });

  it('returns a header plus a timestamped transcript', async () => {
    const client = await connect();
    const res = (await client.callTool({
      name: 'get_transcript',
      arguments: { url: 'https://youtu.be/jNQXAC9IVRw' },
    })) as TextResult;
    const out = res.content[0]?.text ?? '';
    expect(res.isError).toBeFalsy();
    expect(out).toContain('Title: Me at the zoo\nChannel: jawed\nURL: https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(out).toContain('Chapters: 0:00 Intro | 0:05 The cool thing | 0:17 End');
    expect(out).toContain("[0:12] and that's cool");
  });

  it('returns metadata as JSON and failures as tool errors with code and hint', async () => {
    const client = await connect();
    const meta = (await client.callTool({ name: 'get_metadata', arguments: { url: 'jNQXAC9IVRw' } })) as TextResult;
    expect(JSON.parse(meta.content[0]?.text ?? '{}')).toMatchObject({ title: 'Me at the zoo', durationSec: 19 });
    const bad = (await client.callTool({ name: 'get_transcript', arguments: { url: 'xxxxxxxxxxx' } })) as TextResult;
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0]?.text ?? '{}')).toMatchObject({
      error: 'not-found',
      hint: expect.stringContaining('removed'),
    });
  });
});

describe('stdio server', () => {
  it('starts from the bin and keeps stdout clean for the protocol', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'packages/mcp/src/bin.ts')],
      env: { PATH: process.env.PATH ?? '', VID2CONTEXT_LOG_LEVEL: 'info' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);
    await client.close();
  });
});
