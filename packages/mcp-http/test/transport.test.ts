import { afterEach, describe, expect, it } from 'vitest';
import { connectClient, parentWithApi, type Running, rawRequest, start, textOf, ZOO } from './helpers.ts';

const TOKEN = 'test-token-0123456789abcdef';
const ENV = { VID2CONTEXT_MCP_TOKENS: `other-token-aaaaaaaaaaaa, ${TOKEN}` };
const auth = { authorization: `Bearer ${TOKEN}` };

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('Streamable HTTP with a static token', () => {
  it('lists the createServer tools and calls get_metadata in session mode', async () => {
    running = await start(ENV, { mode: 'session' });
    const { client, transport } = await connectClient(running.url, auth);
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_transcript');
    expect(names).toContain('get_metadata');
    const meta = await client.callTool({ name: 'get_metadata', arguments: { url: ZOO } });
    expect(JSON.parse(textOf(meta))).toMatchObject({ title: 'Me at the zoo', durationSec: 19 });
    expect(running.app).toBeDefined();
    await client.close();
  });

  it('serves stateless mode without session ids and answers GET with 405', async () => {
    running = await start(ENV, { mode: 'stateless' });
    const { client, transport } = await connectClient(running.url, auth);
    expect(transport.sessionId).toBeUndefined();
    const res = await client.callTool({ name: 'get_transcript', arguments: { url: ZOO } });
    expect(textOf(res)).toContain('Title: Me at the zoo');
    expect(textOf(res)).toContain("[0:12] and that's cool");
    const get = await fetch(running.url, { headers: { ...auth, accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    await client.close();
  });

  it('answers JSON or SSE as the Accept header asks', async () => {
    running = await start(ENV, { mode: 'stateless' });
    const json = await fetch(running.url, { method: 'POST', headers: { ...MCP_HEADERS, ...auth }, body: initBody });
    expect(json.headers.get('content-type')).toContain('application/json');
    expect((await json.json()) as object).toMatchObject({ result: { serverInfo: { name: 'vid2context' } } });
    const sse = await fetch(running.url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...auth, accept: 'text/event-stream, application/json' },
      body: initBody,
    });
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    expect(await sse.text()).toContain('"serverInfo"');
  });

  it('binds a session to the credential that opened it', async () => {
    running = await start({ VID2CONTEXT_MCP_TOKENS: `${TOKEN},second-token-bbbbbbbbbbbb` }, { mode: 'session' });
    const { transport } = await connectClient(running.url, auth);
    const res = await fetch(running.url, {
      method: 'POST',
      headers: {
        ...MCP_HEADERS,
        authorization: 'Bearer second-token-bbbbbbbbbbbb',
        'mcp-session-id': transport.sessionId as string,
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });

  it('refuses export_obsidian over HTTP, where "this machine" is the server', async () => {
    running = await start(ENV, { mode: 'stateless' });
    const { client } = await connectClient(running.url, auth);
    const res = await client.callTool({ name: 'export_obsidian', arguments: { urls: [ZOO], vaultPath: '/tmp/v2c-vault' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });
});

describe('bearer authentication', () => {
  it('answers a missing token with 401, WWW-Authenticate and the standard error body', async () => {
    running = await start(ENV);
    const res = await fetch(running.url, { method: 'POST', headers: MCP_HEADERS, body: initBody });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer realm="vid2context"/);
    const body = (await res.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('auth');
    expect(body.error.hint).toContain('Authorization: Bearer');
  });

  it('answers a wrong token with 401 invalid_token', async () => {
    running = await start(ENV);
    const res = await fetch(running.url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer not-the-token' },
      body: initBody,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('refuses everything, with a hint, when no credentials are configured', async () => {
    running = await start({});
    const res = await fetch(running.url, { method: 'POST', headers: { ...MCP_HEADERS, ...auth }, body: initBody });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { hint: string } };
    expect(body.error.hint).toContain('VID2CONTEXT_MCP_TOKENS');
  });
});

describe('origin, host and rate limits', () => {
  it('refuses a disallowed Origin with 403 and allows a configured one with CORS headers', async () => {
    running = await start({ ...ENV, VID2CONTEXT_CORS_ORIGINS: 'http://localhost:6274' });
    const evil = await fetch(running.url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...auth, origin: 'https://evil.example' },
      body: initBody,
    });
    expect(evil.status).toBe(403);
    const ok = await fetch(running.url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...auth, origin: 'http://localhost:6274' },
      body: initBody,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:6274');
    expect(ok.headers.get('access-control-expose-headers')).toContain('mcp-session-id');
    const preflight = await fetch(running.url, { method: 'OPTIONS', headers: { origin: 'http://localhost:6274' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('refuses a rebound Host when DNS-rebinding protection is on', async () => {
    running = await start(
      { ...ENV, VID2CONTEXT_MCP_PUBLIC_URL: 'https://mcp.vid2context.com' },
      { dnsRebindingProtection: true },
    );
    const send = (host: string) =>
      rawRequest(running?.url as string, { method: 'POST', headers: { ...MCP_HEADERS, ...auth, host }, body: initBody });
    expect((await send('evil.example')).status).toBe(403);
    expect((await send('mcp.vid2context.com')).status).toBe(200);
    expect((await send(new URL(running.url).host)).status).toBe(200);
  });

  it('answers 429 with Retry-After once a token spends its bucket', async () => {
    running = await start({ ...ENV, VID2CONTEXT_MCP_RATE_LIMIT: '2' }, { mode: 'stateless' });
    const send = () => fetch(running?.url as string, { method: 'POST', headers: { ...MCP_HEADERS, ...auth }, body: initBody });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const third = await send();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe('rate-limited');
  });
});

describe('mounted in a parent app', () => {
  it('keeps its own 401 and leaves the parent routes alone', async () => {
    running = await start(
      { ...ENV, VID2CONTEXT_MCP_PUBLIC_URL: 'https://mcp.vid2context.com' },
      { parent: parentWithApi, dnsRebindingProtection: true },
    );
    const health = await rawRequest(`${running.origin}/api/v1/health`, { headers: { host: 'evil.example' } });
    // The Host check is scoped to this package's paths, so the parent route still answers.
    expect(health.status).toBe(200);
    expect((await rawRequest(running.url, { method: 'POST', headers: { host: 'evil.example' } })).status).toBe(403);
    const res = await fetch(running.url, { method: 'POST', headers: MCP_HEADERS, body: initBody });
    expect(res.status).toBe(401);
    const { client } = await connectClient(running.url, auth);
    expect((await client.listTools()).tools.length).toBeGreaterThan(1);
    await client.close();
  });
});

describe('discovery documents', () => {
  it('serves the server card and the AI catalog from serverJson()', async () => {
    running = await start({ ...ENV, VID2CONTEXT_MCP_PUBLIC_URL: 'https://vid2context.com' });
    const card = await fetch(`${running.url}/server-card`);
    expect(card.headers.get('content-type')).toBe('application/mcp-server-card+json');
    expect(card.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await card.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
      name: 'io.github.nirholas/vid2context',
      remotes: [{ type: 'streamable-http', url: 'https://vid2context.com/mcp' }],
    });
    expect(String(body.description).length).toBeLessThanOrEqual(100);
    const etag = card.headers.get('etag') as string;
    expect((await fetch(`${running.url}/server-card`, { headers: { 'if-none-match': etag } })).status).toBe(304);

    const catalog = await fetch(`${running.origin}/.well-known/ai-catalog.json`);
    expect(catalog.headers.get('content-type')).toBe('application/ai-catalog+json');
    expect(await catalog.json()).toEqual({
      specVersion: '1.0',
      entries: [
        {
          identifier: 'urn:air:vid2context.com:mcp:vid2context',
          type: 'application/mcp-server-card+json',
          url: 'https://vid2context.com/mcp/server-card',
        },
      ],
    });
  });

  it('serves the OpenAI domain challenge only when its token is set', async () => {
    running = await start(ENV);
    expect((await fetch(`${running.origin}/.well-known/openai-apps-challenge`)).status).toBe(404);
    await running.close();
    running = await start({ ...ENV, VID2CONTEXT_OPENAI_APPS_CHALLENGE: 'challenge-value-123' });
    const res = await fetch(`${running.origin}/.well-known/openai-apps-challenge`);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('challenge-value-123');
  });
});
