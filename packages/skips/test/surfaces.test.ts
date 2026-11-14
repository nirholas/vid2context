import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MemoryStorage, Registry, Vid2ContextError } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import youtube from '@vid2context/provider-youtube';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { skipsRoutes } from '../src/http.ts';
import { ATTRIBUTION_HEADER, readSkipValue, SPONSORBLOCK_ATTRIBUTION, type SkipReport, skipQueryOption } from '../src/index.ts';
import { registerSkipsTools } from '../src/mcp.ts';
import { officeContext, requestedCategories, routes } from './fixtures.ts';

const OFFICE_URL = 'https://www.youtube.com/watch?v=CrO0Timw2z4';
const registry = new Registry(youtube, 'node');
const down = () => replayFetch([{ url: /skipSegments/, response: { status: 503, body: '' } }]);

describe('skipQueryOption', () => {
  it('leaves the transcript alone when skip is empty or off', async () => {
    const { transcript } = officeContext();
    const fetch = replayFetch(routes);
    const ctx = testContext({ fetch });
    expect(await skipQueryOption(transcript, ctx, '')).toBe(transcript);
    expect(await skipQueryOption(transcript, ctx, 'none')).toBe(transcript);
    const off = testContext({ fetch, env: { VID2CONTEXT_SPONSORBLOCK: '0' } });
    expect(await skipQueryOption(transcript, off, 'sponsor')).toBe(transcript);
    expect(fetch.calls).toHaveLength(0);
  });

  it('removes the named categories in one call and keeps the input as it was', async () => {
    const { transcript } = officeContext();
    const before = structuredClone(transcript);
    const fetch = replayFetch(routes);
    const out = await skipQueryOption(transcript, testContext({ fetch }), 'sponsor,selfpromo');
    expect(requestedCategories(fetch.calls[0]?.url ?? '')).toEqual(['sponsor', 'selfpromo']);
    expect(out.producer).toBe('youtube-captions+skips');
    const text = out.segments.map((s) => s.text).join(' ');
    expect(text).not.toContain('LTTstore.com');
    expect(text).not.toContain('They sponsored this video');
    // The preview was not asked for, so it stays.
    expect(text).toContain('including setting up a home assistant server');
    expect(transcript).toEqual(before);
  });

  it('"1" means the default categories; unknown names are a bad request', () => {
    const ctx = testContext({ env: { VID2CONTEXT_SKIP_CATEGORIES: 'sponsor' } });
    expect(readSkipValue('1', ctx)).toEqual(['sponsor']);
    expect(readSkipValue('Sponsor, SELFPROMO', ctx)).toEqual(['sponsor', 'selfpromo']);
    expect(() => readSkipValue('sponsors', ctx)).toThrow(Vid2ContextError);
  });

  it('returns the raw transcript when SponsorBlock fails, so a transcript is never blocked', async () => {
    const { transcript } = officeContext();
    const warnings: string[] = [];
    const ctx = {
      ...testContext({ fetch: down() }),
      log: { debug() {}, info() {}, error() {}, warn: (m: string) => void warnings.push(m) },
    };
    expect(await skipQueryOption(transcript, ctx, 'sponsor')).toBe(transcript);
    expect(warnings[0]).toContain('SponsorBlock lookup failed');
    expect(ATTRIBUTION_HEADER).toBe('x-data-attribution');
  });
});

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

async function mcpClient(fetch = replayFetch(routes)) {
  // The transcript comes from storage (the real recorded context), so no YouTube request is made.
  const storage = new MemoryStorage();
  await storage.putContext(officeContext());
  const server = new McpServer({ name: 'skips-test', version: '0.0.0' });
  registerSkipsTools(server, { registry, ctx: testContext({ fetch }), storage });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const reportOf = (res: TextResult) => JSON.parse(res.content[0]?.text ?? '{}') as SkipReport;

describe('MCP get_skip_segments', () => {
  it('returns segments, the transcript share each covers and the attribution', async () => {
    const client = await mcpClient();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['get_skip_segments']);
    const res = (await client.callTool({ name: 'get_skip_segments', arguments: { url: OFFICE_URL } })) as TextResult;
    expect(res.isError).toBeFalsy();
    const report = reportOf(res);
    expect(report.attribution).toBe(SPONSORBLOCK_ATTRIBUTION);
    expect(report.source).toBe('sponsorblock');
    expect(report.segments).toHaveLength(10);
    expect(report.fullVideo?.category).toBe('sponsor');
    expect(report.coveredSec).toBe(192.307);
    expect(report.coveredShare).toBe(0.179); // of 1077 s
    const chair = report.segments.find((s) => s.startSec === 603.067);
    expect(chair).toMatchObject({
      category: 'sponsor',
      time: '10:03-11:03',
      url: 'https://www.youtube.com/watch?v=CrO0Timw2z4&t=603s',
    });
    expect(chair?.transcript?.lines).toBeGreaterThan(10);
    expect(chair?.transcript?.share).toBeGreaterThan(0.03);
    expect(chair?.transcript?.preview.startsWith('>> Meanwhile, in the meeting room')).toBe(true);
    expect(report.transcriptShare).toBeGreaterThan(0.1);
    expect(report.transcriptShare).toBeLessThan(0.3);
  });

  it('honours categories and reports failures as tool errors with a hint', async () => {
    const client = await mcpClient();
    const only = (await client.callTool({
      name: 'get_skip_segments',
      arguments: { url: 'CrO0Timw2z4', categories: ['selfpromo'] },
    })) as TextResult;
    expect(reportOf(only).segments.map((s) => s.category)).toEqual(['selfpromo', 'selfpromo']);

    const failing = await mcpClient(down());
    const err = (await failing.callTool({ name: 'get_skip_segments', arguments: { url: OFFICE_URL } })) as TextResult;
    expect(err.isError).toBe(true);
    expect(JSON.parse(err.content[0]?.text ?? '{}')).toMatchObject({
      error: 'upstream',
      hint: expect.stringContaining('SponsorBlock'),
    });
  });

  it('explains an empty result for a video without segments', async () => {
    const client = await mcpClient();
    const res = (await client.callTool({
      name: 'get_skip_segments',
      arguments: { url: 'https://youtu.be/cCPsdFdlshc' },
    })) as TextResult;
    const report = reportOf(res);
    expect(report.segments).toEqual([]);
    expect(report.note).toContain('no segments');
    expect(report.attribution).toBe(SPONSORBLOCK_ATTRIBUTION);
  });
});

describe('HTTP GET /skips', () => {
  async function app(fetch = replayFetch(routes)) {
    const storage = new MemoryStorage();
    await storage.putContext(officeContext());
    const main = new Hono();
    main.route('/api/v1', skipsRoutes({ registry, makeCtx: () => testContext({ fetch }), storage: async () => storage }));
    // Like the main app's onError: errors thrown in the sub-app reach the parent with their code.
    main.onError((err, c) =>
      c.json({ error: { code: err instanceof Vid2ContextError ? err.code : 'internal', message: err.message } }, 400),
    );
    return main;
  }

  it('answers segments, coveredSec, source and attribution', async () => {
    const main = await app();
    const res = await main.request(`/api/v1/skips?url=${encodeURIComponent(OFFICE_URL)}&categories=sponsor,selfpromo`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SkipReport;
    expect(body).toMatchObject({ videoId: 'youtube:CrO0Timw2z4', source: 'sponsorblock', attribution: SPONSORBLOCK_ATTRIBUTION });
    expect(new Set(body.segments.map((s) => s.category))).toEqual(new Set(['sponsor', 'selfpromo']));
    expect(body.coveredSec).toBeGreaterThan(100);
    expect(body.coveredShare).toBeGreaterThan(0.1);
    expect(body.segments.find((s) => s.category === 'selfpromo')?.transcript?.preview).toContain('desk pad');
  });

  it('rejects a missing url and unknown categories as bad requests', async () => {
    const main = await app();
    const missing = (await (await main.request('/api/v1/skips')).json()) as { error: { code: string } };
    expect(missing.error.code).toBe('bad-request');
    const bad = (await (await main.request('/api/v1/skips?url=CrO0Timw2z4&categories=ads')).json()) as {
      error: { code: string };
    };
    expect(bad.error.code).toBe('bad-request');
  });
});
