/**
 * LIVE=1 only: a real items job over a public playlist (its first 3 videos),
 * streamed over SSE from a real server, against YouTube itself.
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createContext, MemoryStorage, Registry } from '@vid2context/core';
import youtube from '@vid2context/provider-youtube';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { jobsRoutes } from '../src/http.ts';
import { createJobQueue, registerBuiltinKinds } from '../src/index.ts';
import { PLAYLIST } from './helpers.ts';

describe.skipIf(!process.env.LIVE)('items job over a real playlist, streamed over SSE (LIVE)', () => {
  it('streams progress, three item events and a final event', async () => {
    const registry = new Registry(youtube, 'node');
    const ctx = createContext({ runtime: 'node', env: {} });
    const queue = createJobQueue({ registry, ctx, storage: new MemoryStorage() });
    registerBuiltinKinds(queue);
    const app = new Hono().route(
      '/api/v1',
      jobsRoutes({ registry, makeCtx: () => ctx, storage: async () => queue.storage, queue }),
    );
    const port = 20000 + Math.floor(Math.random() * 10000);
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    try {
      const post = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'items', input: PLAYLIST, options: { limit: 3 } }),
      });
      expect(post.status).toBe(202);
      const { id } = (await post.json()) as { id: string };

      const res = await fetch(`${base}/jobs/${id}/events`);
      const text = await res.text(); // The stream closes after done or error.
      const events = text
        .split('\n\n')
        .filter((b) => b.includes('event: '))
        .map((b) => ({
          event: /event: (\w+)/.exec(b)?.[1],
          id: Number(/id: (\d+)/.exec(b)?.[1]),
          data: JSON.parse(/data: (.*)/.exec(b)?.[1] ?? 'null') as Record<string, unknown>,
        }));
      const items = events.filter((e) => e.event === 'item');
      console.error(
        'live items:',
        items
          .map((i) => `${i.data.id} ${i.data.outcome}${i.data.error ? ` (${(i.data.error as { code: string }).code})` : ''}`)
          .join(', '),
      );
      expect(items).toHaveLength(3);
      expect(events.some((e) => e.event === 'progress')).toBe(true);
      expect(['done', 'error']).toContain(events.at(-1)?.event);
      const ids = events.map((e) => e.id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    } finally {
      await queue.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 120_000);
});
