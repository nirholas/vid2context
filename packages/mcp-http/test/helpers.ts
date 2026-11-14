/**
 * Test harness: the real sub-app served by @hono/node-server on a random
 * loopback port, reached by real SDK clients and fetch over HTTP. Upstream
 * calls (YouTube, Client ID Metadata Documents) replay recordings:
 * providers/youtube/test/fixtures (see its README) and test/fixtures/cimd
 * (see test/fixtures/README.md). Nothing here reaches the internet.
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Ctx, type Env, MemoryKv, MemoryStorage } from '@vid2context/core';
import { type RecordedCall, replayFetch, testContext } from '@vid2context/core/testing';
import { createRegistry } from '@vid2context/registry/node';
import { Hono } from 'hono';
import { type McpHttpApp, type McpHttpDeps, mcpHttpRoutes } from '../src/routes.ts';
import { hashPassword } from '../src/scrypt.ts';

export const root = join(import.meta.dirname, '../../..');
const yt = (p: string) => readFileSync(join(root, 'providers/youtube/test/fixtures', p), 'utf8');
const cimd = (p: string) => readFileSync(join(import.meta.dirname, 'fixtures/cimd', p), 'utf8');

export const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const PLAYERS: Record<string, string> = { jNQXAC9IVRw: 'player-jNQXAC9IVRw.json' };
const CIMD_DOCS: Record<string, string> = {
  'https://chatgpt.com/oauth/client.json': 'chatgpt-client.json',
  'https://claude.ai/oauth/mcp-oauth-client-metadata': 'claude-ai-client.json',
  'https://claude.ai/oauth/claude-code-client-metadata': 'claude-code-client.json',
};

/** Recorded upstream responses: the YouTube player and caption calls and the three real CIMD documents. */
export function upstreamReplay() {
  return replayFetch([
    {
      method: 'POST',
      url: /youtubei\/v1\/player/,
      response: (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        return {
          body: yt(PLAYERS[videoId] ?? 'player-unavailable.json'),
          headers: { 'content-type': 'application/json' },
        };
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en/, response: { body: yt('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    {
      method: 'GET',
      url: (u) => u.href in CIMD_DOCS,
      response: (call) => ({
        body: cimd(CIMD_DOCS[call.url] as string),
        // Headers as recorded on 2026-11-14 (see test/fixtures/README.md).
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
      }),
    },
  ]);
}

export const TEST_PASSWORD = 'correct horse battery staple';
let cachedHash: Promise<string> | undefined;
/** A real scrypt hash of TEST_PASSWORD, generated once per test file with cheap parameters. */
export function testPasswordHash(): Promise<string> {
  cachedHash ??= hashPassword(TEST_PASSWORD, { logN: 10, r: 8, p: 1 });
  return cachedHash;
}

export interface Running {
  url: string;
  origin: string;
  app: McpHttpApp;
  calls: RecordedCall[];
  close(): Promise<void>;
}

/** Serve the sub-app (optionally inside a parent app) on 127.0.0.1 at a random port in 20000-29999. */
export async function start(
  env: Env,
  opts: Partial<McpHttpDeps> & { parent?: (sub: McpHttpApp) => Hono; ctx?: (req: Request) => Ctx } = {},
): Promise<Running> {
  const fetch = upstreamReplay();
  const app = mcpHttpRoutes({
    registry: createRegistry(),
    makeCtx: opts.ctx ?? ((req) => testContext({ env, fetch, signal: req.signal })),
    storage: async () => new MemoryStorage(),
    kv: new MemoryKv(),
    ...opts,
  });
  const handler = opts.parent ? opts.parent(app) : app;
  for (let attempt = 0; ; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    try {
      const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        const s = serve({ fetch: handler.fetch, port, hostname: '127.0.0.1' }, () => resolve(s));
        s.once('error', reject);
      });
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return {
        url: `${origin}/mcp`,
        origin,
        app,
        calls: fetch.calls,
        close: async () => {
          await app.closeSessions();
          await new Promise<void>((r) => server.close(() => r()));
        },
      };
    } catch (err) {
      if (attempt > 10) throw err;
    }
  }
}

/** A real SDK client over Streamable HTTP, with optional extra request headers. */
export async function connectClient(url: string, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const client = new Client({ name: 'mcp-http-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

export type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
export const textOf = (r: unknown) => (r as TextResult).content[0]?.text ?? '';

export function parentWithApi(sub: McpHttpApp): Hono {
  const parent = new Hono();
  parent.get('/api/v1/health', (c) => c.json({ ok: true }));
  parent.route('/', sub);
  parent.onError((err, c) => c.json({ error: { code: 'internal', message: err.message } }, 500));
  return parent;
}

/** Pull the hidden form fields and the CSRF cookie out of a consent page response. */
export async function readConsent(res: Response): Promise<{ requestId: string; csrf: string; cookie: string; html: string }> {
  const html = await res.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] ?? '';
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { requestId: field('request_id'), csrf: field('csrf'), cookie, html };
}

/** Submit the consent form as the owner's browser would. */
export function submitConsent(
  origin: string,
  form: { requestId: string; csrf: string; cookie: string },
  password: string,
  decision = 'approve',
): Promise<Response> {
  return fetch(`${origin}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: form.cookie, origin },
    body: new URLSearchParams({ request_id: form.requestId, csrf: form.csrf, password, decision }).toString(),
  });
}

/** An HTTP request with an exact Host header (fetch drops a custom Host, so DNS-rebinding tests need node:http). */
export function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}
