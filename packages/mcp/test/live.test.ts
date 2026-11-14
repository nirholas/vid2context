/**
 * LIVE=1 only: spawn the real stdio server (`tsx packages/mcp/src/bin.ts`)
 * and drive it with the SDK client against real YouTube.
 */
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GWAGON, GWAGON_PLAYLIST, jsonOf, root, type TextResult, textOf, ZOO } from './helpers.ts';

describe.skipIf(!process.env.LIVE)('live: stdio server against real YouTube', () => {
  let client: Client;
  const run = async (name: string, args: Record<string, unknown>) =>
    // Long videos can fall through to speech-to-text, which outlasts the SDK's 60 s default request timeout.
    (await client.callTool({ name, arguments: args }, undefined, { timeout: 280_000 })) as TextResult;

  beforeAll(async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'packages/mcp/src/bin.ts')],
      env,
      stderr: 'inherit',
    });
    client = new Client({ name: 'live-test', version: '0.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('get_outline then get_section by chapter on "Me at the zoo"', async () => {
    const outline = await run('get_outline', { url: ZOO });
    expect(outline.isError, textOf(outline)).toBeFalsy();
    const o = outline.structuredContent as { chapters: { title: string }[]; totalTokens: number };
    expect(o.chapters.length).toBeGreaterThan(0);
    expect(o.totalTokens).toBeGreaterThan(0);
    const section = await run('get_section', { url: ZOO, chapter: 0 });
    expect(textOf(section)).toContain('Title: Me at the zoo');
  });

  it('pages a long transcript and searches what was read', async () => {
    const page = await run('get_transcript', { url: GWAGON, maxTokens: 2000 });
    expect(page.isError, textOf(page)).toBeFalsy();
    expect(textOf(page)).toMatch(/next_cursor: seg:\d+/);
    const hits = await run('search_transcript', { query: 'w463' });
    expect((hits.structuredContent as { count: number }).count).toBeGreaterThan(0);
  }, 300_000);

  it('lists a playlist', async () => {
    const res = await run('list_items', { url: GWAGON_PLAYLIST, limit: 3 });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(jsonOf<{ count: number }>(res).count).toBe(3);
  });
});
