/**
 * Test harness: a real vid2context HTTP server on a random port (20000 to
 * 29999) with the webhook routes mounted, recorded YouTube responses replayed
 * underneath, and a plain HTTP client that sends n8n request options the way
 * n8n's request helper does (baseURL + url, qs, JSON bodies, full responses,
 * the credential's Authorization header).
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { MemoryStorage, Registry } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import youtube from '@vid2context/provider-youtube';
import { createApp } from '@vid2context/server';
import { webhookRoutes, webhookStoreResolver } from '@vid2context/webhooks';
import type { IHttpRequestOptions } from 'n8n-workflow';
import type { Requester } from '../src/shared/trigger.ts';

// Real recordings from providers/youtube/test/fixtures (documented in its README).
const read = (p: string) => readFileSync(join(import.meta.dirname, '../../../providers/youtube/test/fixtures', p), 'utf8');

const youtubeReplay = replayFetch([
  {
    method: 'POST',
    url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    response: (call) => {
      const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
      return { body: read(`player-${videoId === 'jNQXAC9IVRw' ? videoId : 'unavailable'}.json`) };
    },
  },
  { url: /timedtext\?v=jNQXAC9IVRw.*lang=en/, response: { body: read('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
]);

/** Requests to this machine (webhook deliveries to a test receiver) go over the real network stack; everything else is replayed. */
const serverFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(href).hostname === '127.0.0.1' ? globalThis.fetch(input, init) : youtubeReplay(input, init);
}) as typeof fetch;

export interface ApiServer {
  base: string;
  close(): Promise<void>;
  /** The webhook store the routes use, for emitting events from the test. */
  stores: ReturnType<typeof webhookStoreResolver>;
  ctx: ReturnType<typeof testContext>;
}

export async function startApi(): Promise<ApiServer> {
  const env = { VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL: '1' };
  const storage = new MemoryStorage();
  const makeCtx = () => testContext({ env, fetch: serverFetch });
  const stores = webhookStoreResolver({ storage: async () => storage });
  const app = createApp({ registry: new Registry(youtube, 'node'), makeCtx });
  app.route('/api/v1', webhookRoutes({ makeCtx, storage: async () => storage, stores }));

  for (let tries = 0; ; tries++) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    try {
      const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        const s = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve(s));
        s.once('error', reject);
      });
      const address = server.address() as AddressInfo;
      return {
        base: `http://127.0.0.1:${address.port}`,
        stores,
        ctx: makeCtx(),
        close: () =>
          new Promise((resolve) => {
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => resolve());
          }),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || tries > 20) throw err;
    }
  }
}

/** Sends n8n IHttpRequestOptions with fetch, following the semantics of n8n's httpRequest helper that the nodes rely on. */
export function fetchRequester(apiKey = ''): Requester {
  return async (o: IHttpRequestOptions) => {
    const url = new URL(`${o.baseURL ?? ''}${o.url}`);
    for (const [k, v] of Object.entries(o.qs ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      ...(o.headers as Record<string, string> | undefined),
      authorization: `Bearer ${apiKey}`,
    };
    let body: string | undefined;
    if (o.body !== undefined) {
      body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      headers['content-type'] ??= 'application/json';
    }
    const res = await fetch(url, { method: o.method ?? 'GET', headers, body });
    const text = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    const parsed: unknown = o.encoding === 'text' || !contentType.includes('json') || !text ? text : JSON.parse(text);
    if (!res.ok && !o.ignoreHttpStatusErrors) {
      throw Object.assign(new Error(`HTTP ${res.status}`), { httpCode: String(res.status), body: parsed });
    }
    if (!o.returnFullResponse) return parsed;
    return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: parsed };
  };
}
