/**
 * registerAskTools through the MCP SDK's in-memory transport, answering from
 * a recorded LLM response.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clearCooldowns } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerAskTools } from '../src/mcp.ts';
import { GWAGON_URL, loadRecording, makeRegistry, makeStorage, replayRecording } from './helpers.ts';

beforeEach(() => clearCooldowns());

async function connect(recording: string) {
  const { storage } = await makeStorage();
  const server = new McpServer({ name: 'ask-test', version: '0.0.0' });
  registerAskTools(server, {
    registry: makeRegistry(),
    ctx: testContext({ fetch: replayRecording(loadRecording(recording)) }),
    storage,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('MCP ask tool', () => {
  it('is listed and returns the answer with timestamp links', async () => {
    const client = await connect('gwagon-g55');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('ask');
    const res = await client.callTool({
      name: 'ask',
      arguments: {
        question: 'How much horsepower does the G55 AMG compressor engine make, and does it have any known issues?',
        urls: [GWAGON_URL],
      },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Sources:');
    expect(text).toMatch(
      /\[\d+\] Best & Worst G-Wagon Years.* @ \d+:\d\d https:\/\/www\.youtube\.com\/watch\?v=cCPsdFdlshc&t=\d+s/,
    );
  });

  it('returns a tool error with a hint when nothing is given to ground in', async () => {
    const client = await connect('gwagon-g55');
    const res = await client.callTool({ name: 'ask', arguments: { question: 'Anything?' } });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? '{}');
    expect(body.error.code).toBe('bad-request');
    expect(body.error.hint).toBeTruthy();
  });
});
