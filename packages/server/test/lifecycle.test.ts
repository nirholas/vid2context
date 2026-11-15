/**
 * Shutdown and process guards on real sockets and real child processes: a
 * Hono app served by @hono/node-server with a slow request and an event
 * stream that never ends on its own.
 */
import { spawnSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { gracefulClose, socketTimeouts, tuneServer } from '../src/lifecycle.ts';

async function listen(app: Hono): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
      resolve({ server, url: `http://127.0.0.1:${info.port}` }),
    ) as Server;
  });
}

function streamingApp(): Hono {
  const app = new Hono();
  app.get('/slow', async (c) => {
    await new Promise((r) => setTimeout(r, 300));
    return c.text('done');
  });
  app.get('/events', () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': open\n\n'));
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  return app;
}

describe('gracefulClose', () => {
  it('lets in-flight requests finish, runs cleanup, then cuts a stream that never ends', async () => {
    const { server, url } = await listen(streamingApp());
    const events = await fetch(`${url}/events`);
    const reader = (events.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const slow = fetch(`${url}/slow`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    let cleaned = false;
    const started = Date.now();
    const outcome = await gracefulClose(server, {
      graceMs: 1500,
      cleanup: async () => {
        cleaned = true;
      },
    });
    expect(outcome).toBe('forced');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await slow).toBe('done');
    expect(cleaned).toBe(true);
    // The stream was cut: reading ends (or errors) instead of hanging.
    const end = await reader.read().catch(() => ({ done: true }));
    expect(end.done).toBe(true);
    expect(server.listening).toBe(false);
  });

  it('closes cleanly when nothing is open', async () => {
    const { server } = await listen(streamingApp());
    expect(await gracefulClose(server, { graceMs: 1000, cleanup: async () => undefined })).toBe('clean');
  });
});

describe('socket timeouts', () => {
  it('applies env timeouts with safe defaults', async () => {
    expect(socketTimeouts({})).toEqual({ headersTimeoutMs: 30_000, keepAliveTimeoutMs: 5_000, requestTimeoutMs: 300_000 });
    const { server } = await listen(streamingApp());
    tuneServer(server, { VID2CONTEXT_HEADERS_TIMEOUT_MS: '2000', VID2CONTEXT_KEEPALIVE_TIMEOUT_MS: '1000' });
    expect(server.headersTimeout).toBe(2000);
    expect(server.keepAliveTimeout).toBe(1000);
    expect(server.requestTimeout).toBe(300_000);
    await gracefulClose(server, { graceMs: 500, cleanup: async () => undefined });
  });

  it('drops a client that never finishes its headers', async () => {
    const { server, url } = await listen(streamingApp());
    tuneServer(server, { VID2CONTEXT_HEADERS_TIMEOUT_MS: '500', VID2CONTEXT_BODY_TIMEOUT_MS: '1000' });
    const { connect } = await import('node:net');
    const port = (server.address() as AddressInfo).port;
    const started = Date.now();
    const answer = await new Promise<string>((resolve) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('GET /slow HTTP/1.1\r\nHost: x\r\n'));
      let got = '';
      sock.on('data', (d) => {
        got += d.toString();
      });
      sock.on('close', () => resolve(got));
    });
    expect(answer).toContain('408');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(url).toContain('127.0.0.1');
    await gracefulClose(server, { graceMs: 500, cleanup: async () => undefined });
  });
});

describe('unhandled rejection guard (real child processes)', () => {
  const script = `
    import { installRejectionGuard } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'lifecycle.ts'))};
    installRejectionGuard(process.env, (m) => console.error(m));
    Promise.reject(new Error('stray provider rejection'));
    setTimeout(() => console.log('still serving'), 200);
  `;
  const runChild = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
      cwd: join(import.meta.dirname, '..', '..', '..'),
    });

  it('logs the rejection with its stack and keeps the process running', () => {
    const res = runChild({});
    expect(res.stdout).toContain('still serving');
    expect(res.stderr).toContain('unhandled promise rejection');
    expect(res.stderr).toContain('stray provider rejection');
    expect(res.status).toBe(0);
  });

  it('exits as Node does by default with VID2CONTEXT_EXIT_ON_UNHANDLED=1', () => {
    const res = runChild({ VID2CONTEXT_EXIT_ON_UNHANDLED: '1' });
    expect(res.stdout).not.toContain('still serving');
    expect(res.status).not.toBe(0);
  });
});
