/**
 * The innertube `next` endpoint (the watch page's data) with the WEB client.
 * It answers keyless and carries what the ANDROID player response lacks:
 * the publish date, the exact like count, the channel handle and subscriber
 * text, and YouTube's own chapter markers and auto chapters ("key moments").
 *
 * The request goes through prompt 06's shared transport (breaker, retries,
 * error taxonomy, optional credentials). WEB is not one of the player
 * clients, so its spec lives here. YouTube retires old WEB versions now and
 * then; override the version with YOUTUBE_WEB_VERSION (the same variable the
 * browse module reads) without a release.
 */
import type { Ctx } from '@vid2context/core';
import type { ClientSpec } from '../resilience/clients.ts';
import { innertubeRequest } from '../resilience/transport.ts';

/** Read from youtube.com's INNERTUBE_CLIENT_VERSION on 2026-11-14. */
export const DEFAULT_WEB_VERSION = '2.20261112.10.00';

const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function webClient(ctx: Ctx): ClientSpec {
  return {
    key: 'web',
    clientName: 'WEB',
    clientId: 1,
    version: ctx.env.YOUTUBE_WEB_VERSION?.trim() || DEFAULT_WEB_VERSION,
    userAgent: () => DESKTOP_UA,
    context: { gl: 'US' },
  };
}

/** POST /youtubei/v1/next for one video. Returns the raw JSON; watch.ts reads it. */
export function fetchNext(videoId: string, ctx: Ctx): Promise<unknown> {
  return innertubeRequest('next', { videoId }, webClient(ctx), ctx, { stage: 'metadata' });
}
