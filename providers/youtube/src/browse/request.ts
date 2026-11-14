/**
 * Minimal innertube request for the browse, search and navigation endpoints.
 * These endpoints answer the WEB client without a key or a visitor cookie.
 * Prompt 06 owns the shared transport in ../innertube.ts; once it exports a
 * generic request helper, this file should switch to it.
 *
 * YouTube retires old client versions from time to time; override the
 * version with YOUTUBE_WEB_VERSION without a release.
 */
import { type Ctx, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { youtubeHttpError } from '../innertube.ts';

export const DEFAULT_WEB_VERSION = '2.20261002.00.00';

export type Endpoint = 'browse' | 'search' | 'navigation/resolve_url';

/** Raw innertube JSON. The browse parsers walk it defensively. */
export type Json = Record<string, unknown>;

export function webVersion(ctx: Ctx): string {
  return ctx.env.YOUTUBE_WEB_VERSION || DEFAULT_WEB_VERSION;
}

/** POST /youtubei/v1/<endpoint> with the WEB client and return the parsed JSON. */
export async function innertubeWeb(endpoint: Endpoint, body: Json, ctx: Ctx, label: string): Promise<Json> {
  const version = webVersion(ctx);
  const res = await fetchWithTimeout(ctx, `https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-youtube-client-name': '1',
      'x-youtube-client-version': version,
    },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: version, hl: 'en', gl: 'US' } }, ...body }),
  });
  if (res.status === 404) {
    await res.body?.cancel();
    throw new Vid2ContextError('not-found', `${label}: YouTube answered HTTP 404.`, {
      status: 404,
      hint: 'Check the URL: the playlist or channel may not exist, or it was removed.',
    });
  }
  if (!res.ok) throw await youtubeHttpError(res, label);
  return (await res.json()) as Json;
}
