/**
 * safeFetch against a real HTTP server on 127.0.0.1 (random port 20000-29999).
 * The first hop is allowed only through an explicit test policy (allowHosts);
 * everything the server redirects to is judged by the default rules.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../../src/context.ts';
import { safeFetch } from '../../src/security/index.ts';
import type { Logger } from '../../src/types.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const ctx = createContext({ runtime: 'node', env: {}, fetch: globalThis.fetch.bind(globalThis), log: silent });

let server: Server;
let base = '';
let policy: { allowHosts: string[] };
const requests: string[] = [];
let bigClosedEarly: Promise<boolean> = Promise.resolve(false);

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '/';
  requests.push(path);
  if (path === '/to-metadata') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' });
    res.end();
  } else if (path === '/to-decimal-loopback') {
    res.writeHead(307, { location: 'http://2130706433/admin' });
    res.end();
  } else if (path === '/hop') {
    res.writeHead(301, { location: '/final' });
    res.end();
  } else if (path === '/final') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end('<rss version="2.0"></rss>');
  } else if (path === '/loop') {
    res.writeHead(302, { location: '/loop' });
    res.end();
  } else if (path === '/big') {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    let sent = 0;
    bigClosedEarly = new Promise((resolve) => {
      res.on('close', () => resolve(!res.writableFinished));
    });
    const pump = () => {
      while (sent < 64 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  } else if (path === '/declared-big') {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(50 * 1024 * 1024) });
    res.write(Buffer.alloc(1024));
  } else if (path === '/html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html></html>');
  } else if (path === '/hang') {
    // Never answers; the client must time out.
  } else {
    res.writeHead(404);
    res.end();
  }
}

beforeAll(async () => {
  server = createServer(handle);
  for (let i = 0; i < 20; i++) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) break;
  }
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  policy = { allowHosts: [`127.0.0.1:${port}`] };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('safeFetch', () => {
  it('refuses a local address on the first hop under the default policy', async () => {
    const before = requests.length;
    await expect(safeFetch(ctx, `${base}/final`, { maxBytes: 1000 })).rejects.toMatchObject({ code: 'unsupported-input' });
    expect(requests.length).toBe(before);
  });

  it('refuses a redirect to the cloud metadata address on the second hop', async () => {
    const err = await safeFetch(ctx, `${base}/to-metadata`, { maxBytes: 1000, policy }).catch((e) => e);
    expect(err).toMatchObject({ code: 'unsupported-input' });
    expect(err.message).toContain('Refused redirect 1 to http://169.254.169.254/');
  });

  it('refuses a redirect to a decimal-encoded loopback address', async () => {
    const err = await safeFetch(ctx, `${base}/to-decimal-loopback`, { maxBytes: 1000, policy }).catch((e) => e);
    expect(err).toMatchObject({ code: 'unsupported-input' });
    expect(err.message).toContain('127.0.0.1');
  });

  it('follows allowed redirects and returns the final URL, hops and body', async () => {
    const res = await safeFetch(ctx, `${base}/hop`, { maxBytes: 1000, policy, accept: ['application/rss+xml'] });
    expect(res.status).toBe(200);
    expect(res.url).toBe(`${base}/final`);
    expect(res.hops).toEqual([`${base}/hop`, `${base}/final`]);
    expect(new TextDecoder().decode(res.bytes)).toBe('<rss version="2.0"></rss>');
  });

  it('stops after maxRedirects', async () => {
    await expect(safeFetch(ctx, `${base}/loop`, { maxBytes: 1000, policy, maxRedirects: 3 })).rejects.toMatchObject({
      code: 'upstream',
    });
  });

  it('aborts a streamed body past maxBytes with too-large and closes the connection', async () => {
    await expect(safeFetch(ctx, `${base}/big`, { maxBytes: 200_000, policy })).rejects.toMatchObject({ code: 'too-large' });
    expect(await bigClosedEarly).toBe(true);
  });

  it('refuses a declared Content-Length above maxBytes before reading', async () => {
    await expect(safeFetch(ctx, `${base}/declared-big`, { maxBytes: 1_000_000, policy })).rejects.toMatchObject({
      code: 'too-large',
    });
  });

  it('refuses an unexpected Content-Type', async () => {
    await expect(safeFetch(ctx, `${base}/html`, { maxBytes: 1000, policy, accept: ['audio/'] })).rejects.toMatchObject({
      code: 'upstream',
    });
  });

  it('times out with the timeout code', async () => {
    await expect(safeFetch(ctx, `${base}/hang`, { maxBytes: 1000, policy, timeoutMs: 300 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});
