/**
 * Comments are read from innertube `next` as the WEB client: it is the client
 * whose watch page carries the comments section and the Top/Newest sort menu,
 * and it answers without a key. Requests go through the shared YouTube
 * transport, so they get its circuit breaker, retries and error taxonomy.
 *
 * YouTube retires old WEB versions from time to time; override the version
 * with YOUTUBE_WEB_VERSION (shared with the browse and search module).
 */
import type { Ctx } from '@vid2context/core';
import type { ClientSpec } from '../resilience/clients.ts';
import { innertubeRequest } from '../resilience/transport.ts';
import type { Json } from './parse.ts';

/** Verified live on 2026-11-14. */
export const DEFAULT_WEB_VERSION = '2.20251110.01.00';

const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function webClient(ctx: Ctx): ClientSpec {
  return {
    key: 'web',
    clientName: 'WEB',
    clientId: 1,
    version: ctx.env.YOUTUBE_WEB_VERSION?.trim() || DEFAULT_WEB_VERSION,
    userAgent: () => WEB_USER_AGENT,
    context: { gl: 'US' },
  };
}

/** POST /youtubei/v1/next with either `{ videoId }` or `{ continuation }`. */
export function nextRequest(body: { videoId: string } | { continuation: string }, ctx: Ctx): Promise<Json> {
  return innertubeRequest<Json>('next', body, webClient(ctx), ctx);
}
