/**
 * Innertube requests for the browse, search and navigation endpoints. They go
 * through prompt 06's shared transport (breaker, retries, block detection,
 * optional cookie and visitorData) with the WEB client: browse and search
 * answer it keylessly and return the compact web renderers the parsers read,
 * while the ANDROID client returns a different and much larger layout.
 *
 * YouTube retires old client versions from time to time; override the WEB
 * version with YOUTUBE_WEB_VERSION without a release.
 */
import type { Ctx } from '@vid2context/core';
import type { ClientSpec } from '../resilience/clients.ts';
import { innertubeRequest } from '../resilience/transport.ts';

export const DEFAULT_WEB_VERSION = '2.20251110.01.00';

export type Endpoint = 'browse' | 'search' | 'navigation/resolve_url';

/** Raw innertube JSON. The browse parsers walk it defensively. */
export type Json = Record<string, unknown>;

export function webClient(ctx: Ctx): ClientSpec {
  return {
    key: 'web',
    clientName: 'WEB',
    clientId: 1,
    version: ctx.env.YOUTUBE_WEB_VERSION?.trim() || DEFAULT_WEB_VERSION,
    userAgent: () =>
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    context: { gl: 'US' },
  };
}

/** POST /youtubei/v1/<endpoint> with the WEB client and return the parsed JSON. */
export function innertubeWeb(endpoint: Endpoint, body: Json, ctx: Ctx): Promise<Json> {
  return innertubeRequest<Json>(endpoint, body, webClient(ctx), ctx);
}
