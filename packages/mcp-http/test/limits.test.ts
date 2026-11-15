/** Request body limits on /mcp and the OAuth endpoints, over real HTTP to the real sub-app. */
import { afterEach, describe, expect, it } from 'vitest';
import { type Running, rawRequest, start } from './helpers.ts';

const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('body limits (VID2CONTEXT_MCP_MAX_BODY_KB)', () => {
  it('refuses an oversized /mcp body with Content-Length before the SDK reads it, and serves a normal one', async () => {
    running = await start({ VID2CONTEXT_MCP_TOKENS: TOKEN, VID2CONTEXT_MCP_MAX_BODY_KB: '1' }, { mode: 'stateless' });
    const big = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { pad: 'x'.repeat(4096) } });
    const res = await rawRequest(running.url, { method: 'POST', headers: { ...MCP_HEADERS, ...auth }, body: big });
    expect(res.status).toBe(413);
    const body = JSON.parse(res.body) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('too-large');
    expect(body.error.hint).toContain('VID2CONTEXT_MCP_MAX_BODY_KB');
    const ok = await rawRequest(running.url, { method: 'POST', headers: { ...MCP_HEADERS, ...auth }, body: initBody });
    expect(ok.status).toBe(200);
  });

  it('cuts off a chunked body with no Content-Length while it streams', async () => {
    running = await start({ VID2CONTEXT_MCP_TOKENS: TOKEN, VID2CONTEXT_MCP_MAX_BODY_KB: '1' }, { mode: 'stateless' });
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await fetch(running.url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...auth },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it('caps the OAuth token endpoint too', async () => {
    running = await start({ VID2CONTEXT_MCP_TOKENS: TOKEN, VID2CONTEXT_MCP_MAX_BODY_KB: '1' }, { mode: 'stateless' });
    const tokenUrl = new URL('/oauth/token', running.url).href;
    const res = await rawRequest(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=${'a'.repeat(4096)}`,
    });
    expect(res.status).toBe(413);
  });
});
