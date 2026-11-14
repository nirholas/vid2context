import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clearCooldowns } from '@vid2context/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerResearchTools } from '../src/mcp.ts';
import { ctxWith, filledStorage, GWAGON, llmRoute, loadLlmFixture, makeRegistry, playerRoute, ZOO } from './helpers.ts';

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

const fixture = loadLlmFixture('key-moments-cCPsdFdlshc.json');

async function connect() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerResearchTools(server, {
    registry: makeRegistry(),
    ctx: ctxWith([playerRoute, llmRoute(fixture)]),
    storage: await filledStorage(),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const call = async (name: string, args: Record<string, unknown>) =>
  (await (await connect()).callTool({ name, arguments: args })) as TextResult;
const textOf = (r: TextResult) => r.content[0]?.text ?? '';

beforeEach(() => clearCooldowns());

describe('MCP research tools', () => {
  it('lists the three tools as read-only', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_key_moments', 'list_caption_languages', 'research_videos']);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('research_videos returns cited excerpts as compact text, or JSON on request', async () => {
    const res = await call('research_videos', { urls: [GWAGON, ZOO], query: 'engine' });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('[0:43](https://www.youtube.com/watch?v=cCPsdFdlshc&t=43s)');
    const json = await call('research_videos', { urls: [GWAGON], query: 'engine', format: 'json', maxExcerpts: 1 });
    const body = JSON.parse(textOf(json));
    expect(body.results[0].excerpts).toHaveLength(1);
    expect(body.results[0].excerpts[0]).toMatchObject({ startSec: 43.76, timestamp: '[0:43]' });
  });

  it('list_caption_languages returns tracks and translation targets', async () => {
    const body = JSON.parse(textOf(await call('list_caption_languages', { url: GWAGON })));
    expect(body.tracks[0]).toMatchObject({ language: 'en', origin: 'auto-captions' });
    expect(body.translationTargets).toHaveLength(16);
  });

  it('get_key_moments returns verified moments and the rung', async () => {
    const body = JSON.parse(textOf(await call('get_key_moments', { url: GWAGON, count: fixture.options.count })));
    expect(body.rung).toBe(fixture.rung);
    expect(body.moments.length).toBeGreaterThan(0);
    expect(body.moments[0].url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=cCPsdFdlshc&t=\d+s$/);
  });

  it('returns errors as tool results with code and hint', async () => {
    const res = await call('research_videos', { urls: [GWAGON], query: 'the and of' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res))).toMatchObject({ error: 'bad-request', hint: expect.any(String), attempts: [] });
    const gone = await call('list_caption_languages', { url: 'https://youtu.be/xxxxxxxxxxx' });
    expect(gone.isError).toBe(true);
    expect(JSON.parse(textOf(gone)).error).toBe('not-found');
  });
});
