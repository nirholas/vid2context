/**
 * open_transcript_viewer over the MCP protocol with a real SDK client. The
 * context comes from a MemoryStorage pre-filled with the shared real
 * fixture (tests/fixtures/contexts/youtube-cCPsdFdlshc.json), so the pipeline answers from storage and never touches the
 * network (the replay fetch has no routes and records every call).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MemoryStorage, Registry, type StorageProvider, type VideoContext } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import youtube from '@vid2context/provider-youtube';
import { describe, expect, it } from 'vitest';
import { toViewerData, VIEWER_URI } from '../src/data.ts';
import { registerAppsTools, TEXT_FALLBACK_CHARS } from '../src/mcp.ts';
import { VIEWER_HTML } from '../src/ui/viewer.html.ts';

const context = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json'), 'utf8'),
) as VideoContext;
const URL_INPUT = 'https://www.youtube.com/watch?v=cCPsdFdlshc';

async function connect(opts: { apps: boolean }) {
  const storage = new MemoryStorage();
  await storage.putContext(context);
  const memory: StorageProvider = {
    id: 'mcp-apps-test-memory',
    kind: 'storage',
    name: 'Memory storage with the shared fixture',
    runtimes: ['node'],
    priority: -1000,
    isEnabled: () => true,
    create: async () => storage,
  };
  // The real YouTube provider resolves the URL; the context itself comes from storage.
  const registry = new Registry([...youtube, memory], 'node');
  const fetch = replayFetch([]);
  const server = new McpServer({ name: 'vid2context', version: '0.1.0' });
  registerAppsTools(server, { registry, ctx: testContext({ fetch }) });
  const client = new Client(
    { name: opts.apps ? 'apps-host' : 'text-client', version: '0.0.0' },
    { capabilities: opts.apps ? { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } } } : {} },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, fetch };
}

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

describe('open_transcript_viewer', () => {
  it('links the tool to the UI resource in tools/list', async () => {
    const { client } = await connect({ apps: true });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'open_transcript_viewer');
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: VIEWER_URI }, 'ui/resourceUri': VIEWER_URI });
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['language', 'url']);
    expect(tool?.outputSchema?.properties).toHaveProperty('segments');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('returns structuredContent, the capped text fallback and no network calls in an MCP Apps client', async () => {
    const { client, fetch } = await connect({ apps: true });
    const res = (await client.callTool({ name: 'open_transcript_viewer', arguments: { url: URL_INPUT } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(fetch.calls).toHaveLength(0);

    const data = toViewerData(context);
    expect(res.structuredContent).toEqual(data);
    const segments = res.structuredContent?.segments as [number, number, string][];
    expect(segments).toHaveLength(521);
    expect(segments[0]).toEqual([0.64, 2.08, "so you're going to buy G wagon which"]);
    expect(res.structuredContent?.timestampBase).toBe('https://www.youtube.com/watch?v=cCPsdFdlshc&t={t}s');
    expect(res.structuredContent?.metadata).toMatchObject({
      id: 'youtube:cCPsdFdlshc',
      title: 'Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!',
      channel: 'Alliance Motorworks',
      durationSec: 1084,
      origin: 'auto-captions',
      language: 'en',
    });

    const text = res.content[0]?.text ?? '';
    expect(
      text.startsWith(
        'Title: Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!\nChannel: Alliance Motorworks\n',
      ),
    ).toBe(true);
    expect(text).toContain("[0:00] so you're going to buy G wagon which");
    expect(text).toMatch(
      /\[Showing the first \d+ of \d+ transcript lines \(521 segments\)\. The full transcript is in the transcript viewer/,
    );
    expect(text.length).toBeLessThan(TEXT_FALLBACK_CHARS + 1000);
    const lastLine = context.transcript.segments.at(-1)?.text ?? '';
    expect(text).not.toContain(lastLine);
  });

  it('returns the header and the full transcript as text in a client without MCP Apps', async () => {
    const { client } = await connect({ apps: false });
    const res = (await client.callTool({ name: 'open_transcript_viewer', arguments: { url: URL_INPUT } })) as ToolResult;
    const text = res.content[0]?.text ?? '';
    expect(text.startsWith('Title: Best & Worst G-Wagon Years')).toBe(true);
    expect(text).not.toContain('[Showing the first');
    expect(text).toContain(context.transcript.segments.at(-1)?.text ?? 'missing');
    expect(res.structuredContent?.segments).toHaveLength(521);
  });

  it('serves the viewer HTML with the MCP Apps mime type on resources/read', async () => {
    const { client } = await connect({ apps: true });
    const { resources } = await client.listResources();
    expect(resources.find((r) => r.uri === VIEWER_URI)).toMatchObject({ mimeType: RESOURCE_MIME_TYPE });
    const read = await client.readResource({ uri: VIEWER_URI });
    const item = read.contents[0] as { uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> };
    expect(item.uri).toBe(VIEWER_URI);
    expect(item.mimeType).toBe('text/html;profile=mcp-app');
    expect(item.text).toBe(VIEWER_HTML);
    expect(item.text.startsWith('<!doctype html>')).toBe(true);
    expect(item._meta).toMatchObject({ ui: { prefersBorder: true, permissions: { clipboardWrite: {} } } });
  });

  it('returns failures as tool errors with a code and a hint', async () => {
    const { client } = await connect({ apps: true });
    const res = (await client.callTool({
      name: 'open_transcript_viewer',
      arguments: { url: 'not a video at all' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    const err = JSON.parse(res.content[0]?.text ?? '{}') as { error: string; hint?: string };
    expect(err.error).toBe('unsupported-input');
    expect(err.hint).toBeTruthy();
  });
});
