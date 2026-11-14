/**
 * YOUTUBE_PROXY against a real local CONNECT proxy. The proxy checks
 * Proxy-Authorization, counts tunnels and forwards every tunnel to a local
 * HTTP server, so no request leaves the machine and no YouTube payload is
 * involved: the test only checks which requests go through which proxy.
 */
import { createServer, type Server } from 'node:http';
import { type AddressInfo, connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isYouTubeHost, parseProxyList, youtubeProxyFetch } from '../src/proxy.ts';

interface TestProxy {
  server: Server;
  port: number;
  tunnels: string[];
  auth: (string | undefined)[];
}

let origin: Server;
let originPort: number;
const proxies: TestProxy[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function startProxy(): Promise<TestProxy> {
  const p: TestProxy = { server: createServer(), port: 0, tunnels: [], auth: [] };
  const sockets = new Set<Socket>();
  p.server.on('connect', (req, client: Socket) => {
    p.tunnels.push(req.url ?? '');
    p.auth.push(req.headers['proxy-authorization']);
    const upstream = connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('error', () => s.destroy());
      s.on('close', () => sockets.delete(s));
    }
  });
  p.server.on('close', () => {
    for (const s of sockets) s.destroy();
  });
  p.port = await listen(p.server);
  proxies.push(p);
  return p;
}

beforeAll(async () => {
  origin = createServer((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end(`origin saw ${req.method} ${req.headers.host}${req.url}`);
  });
  originPort = await listen(origin);
});

afterAll(async () => {
  for (const p of proxies) {
    p.server.closeAllConnections();
    await new Promise((r) => p.server.close(r));
  }
  origin.closeAllConnections();
  await new Promise((r) => origin.close(r));
});

/** A base fetch that records what bypassed the proxy and answers without the network. */
function recordingBase() {
  const seen: string[] = [];
  const base = (async (input: Parameters<typeof fetch>[0]) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return new Response('direct');
  }) as typeof fetch;
  return { seen, base };
}

describe('isYouTubeHost', () => {
  it('matches the YouTube site, API, short links, embeds and media hosts', () => {
    for (const h of [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
      'www.youtube-nocookie.com',
    ]) {
      expect(isYouTubeHost(h)).toBe(true);
    }
    expect(isYouTubeHost('rr3---sn-4g5edn6k.googlevideo.com')).toBe(true);
    expect(isYouTubeHost('youtubei.googleapis.com')).toBe(true);
  });

  it('leaves look-alikes and other services alone', () => {
    for (const h of [
      'notyoutube.com',
      'youtube.com.evil.example',
      'api.openai.com',
      'generativelanguage.googleapis.com',
      'i.ytimg.com',
    ]) {
      expect(isYouTubeHost(h)).toBe(false);
    }
  });
});

describe('parseProxyList', () => {
  it('reads one or several http(s) proxies', () => {
    expect(parseProxyList(undefined)).toEqual([]);
    expect(parseProxyList(' ')).toEqual([]);
    expect(parseProxyList('http://a:1, https://u:p@b:2').map((u) => u.host)).toEqual(['a:1', 'b:2']);
  });

  it('rejects SOCKS and non-URLs without echoing the value', () => {
    expect(() => parseProxyList('socks5://u:secretpw@h:1080')).toThrow(/entry 1 uses socks5:.*no SOCKS/);
    expect(() => parseProxyList('http://ok:1,not a url')).toThrow(/entry 2 is not a URL/);
    try {
      parseProxyList('socks5://u:secretpw@h:1080');
    } catch (err) {
      expect(String(err)).not.toContain('secretpw');
    }
  });
});

describe('youtubeProxyFetch', () => {
  it('returns the base fetch unchanged without YOUTUBE_PROXY', () => {
    const { base } = recordingBase();
    expect(youtubeProxyFetch({}, base)).toBe(base);
  });

  it('sends YouTube requests through the proxy with Basic credentials and everything else direct', async () => {
    const p = await startProxy();
    const { seen, base } = recordingBase();
    const f = youtubeProxyFetch({ YOUTUBE_PROXY: `http://alice:s3cret@127.0.0.1:${p.port}` }, base);

    const res = await f('http://www.youtube.com/api/timedtext?v=jNQXAC9IVRw');
    expect(await res.text()).toBe('origin saw GET www.youtube.com/api/timedtext?v=jNQXAC9IVRw');
    expect(p.tunnels).toEqual(['www.youtube.com:80']);
    expect(p.auth).toEqual([`Basic ${Buffer.from('alice:s3cret').toString('base64')}`]);

    const other = await f('https://api.groq.com/openai/v1/models');
    expect(await other.text()).toBe('direct');
    expect(seen).toEqual(['https://api.groq.com/openai/v1/models']);
    expect(p.tunnels).toHaveLength(1);
  });

  it('opens a new tunnel per request, so a rotating gateway can change the exit IP', async () => {
    const p = await startProxy();
    const f = youtubeProxyFetch({ YOUTUBE_PROXY: `http://127.0.0.1:${p.port}` });
    for (let i = 0; i < 3; i++) await (await f('http://www.youtube.com/youtubei/v1/player')).text();
    expect(p.tunnels).toHaveLength(3);
  });

  it('rotates across several proxies and keeps POST bodies', async () => {
    const a = await startProxy();
    const b = await startProxy();
    const f = youtubeProxyFetch({ YOUTUBE_PROXY: `http://127.0.0.1:${a.port},http://127.0.0.1:${b.port}` });
    const bodies: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await f('http://m.youtube.com/youtubei/v1/next', { method: 'POST', body: '{"videoId":"x"}' });
      bodies.push(await res.text());
    }
    expect(a.tunnels).toHaveLength(2);
    expect(b.tunnels).toHaveLength(2);
    expect(bodies.every((t) => t === 'origin saw POST m.youtube.com/youtubei/v1/next')).toBe(true);
  });
});
