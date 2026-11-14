/**
 * The one place that talks HTTP to YouTube. Every request goes through the
 * circuit breaker, the retry policy and the error taxonomy, and carries the
 * optional credentials from ctx.env:
 *
 *   YOUTUBE_COOKIE        raw Cookie header value; with a SAPISID cookie the
 *                         SAPISIDHASH Authorization header is derived from it
 *   YOUTUBE_VISITOR_DATA  sent as context.client.visitorData and x-goog-visitor-id
 *   YOUTUBE_PO_TOKEN      proof-of-origin token (player body and timedtext &pot=)
 *
 * Their values are never logged.
 *
 * innertubeRequest is exported for the other YouTube modules (next, browse,
 * search), so they share transport, breaker and errors instead of copying them.
 */
import { type Ctx, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { withRetry } from './backoff.ts';
import { assertBreakerClosed, tripBreaker } from './breaker.ts';
import { type ClientSpec, clientByName } from './clients.ts';
import { youtubeHttpError } from './errors.ts';

const ORIGIN = 'https://www.youtube.com';
const INNERTUBE = `${ORIGIN}/youtubei/v1/`;

export type Stage = 'metadata' | 'captions';

async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cookieValue(cookie: string, name: string): string | undefined {
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Cookie and, when the cookie has a SAPISID, the SAPISIDHASH Authorization header YouTube expects with it. */
export async function credentialHeaders(ctx: Ctx): Promise<Record<string, string>> {
  const cookie = ctx.env.YOUTUBE_COOKIE?.trim();
  if (!cookie) return {};
  const headers: Record<string, string> = { cookie };
  const sapisid = cookieValue(cookie, 'SAPISID') ?? cookieValue(cookie, '__Secure-3PAPISID');
  if (sapisid) {
    const ts = Math.floor(Date.now() / 1000);
    headers.authorization = `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${ORIGIN}`)}`;
    headers['x-origin'] = ORIGIN;
  }
  return headers;
}

/** Run a YouTube call under the breaker and retry policy, opening the breaker on a block. */
export async function guarded<T>(ctx: Ctx, stage: Stage, label: string, fn: () => Promise<T>): Promise<T> {
  assertBreakerClosed(stage);
  try {
    return await withRetry(ctx, label, fn);
  } catch (err) {
    if (err instanceof Vid2ContextError && err.code === 'blocked') tripBreaker(err, ctx);
    throw err;
  }
}

/**
 * POST /youtubei/v1/<endpoint> as the given client. The client context
 * (name, version, platform fields, visitorData) is merged into body.context.
 */
export async function innertubeRequest<T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
  client: ClientSpec | string,
  ctx: Ctx,
  opts: { stage?: Stage } = {},
): Promise<T> {
  const spec = typeof client === 'string' ? clientByName(client, ctx.env) : client;
  if (!spec)
    throw new Vid2ContextError('bad-request', `Unknown YouTube client "${String(client)}".`, { hint: 'Use android or ios.' });
  const visitorData = ctx.env.YOUTUBE_VISITOR_DATA?.trim();
  const given = (body.context ?? {}) as Record<string, unknown>;
  const payload = {
    ...body,
    context: {
      ...given,
      client: {
        clientName: spec.clientName,
        clientVersion: spec.version,
        hl: 'en',
        ...spec.context,
        ...(visitorData ? { visitorData } : {}),
        ...((given.client as Record<string, unknown> | undefined) ?? {}),
      },
    },
  };
  const label = `YouTube ${endpoint} (${spec.key})`;
  return guarded(ctx, opts.stage ?? 'metadata', label, async () => {
    const res = await fetchWithTimeout(ctx, `${INNERTUBE}${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': spec.userAgent(spec.version),
        'x-youtube-client-name': String(spec.clientId),
        'x-youtube-client-version': spec.version,
        origin: ORIGIN,
        ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {}),
        ...(await credentialHeaders(ctx)),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await youtubeHttpError(res, label);
    return (await res.json()) as T;
  });
}

/** GET a YouTube URL (timedtext) under the breaker and retry policy. Returns the OK response or throws the mapped error. */
export function youtubeGet(url: string, ctx: Ctx, label: string, stage: Stage = 'captions'): Promise<Response> {
  return guarded(ctx, stage, label, async () => {
    const res = await fetchWithTimeout(ctx, url, { headers: await credentialHeaders(ctx) });
    if (!res.ok) throw await youtubeHttpError(res, label);
    return res;
  });
}
