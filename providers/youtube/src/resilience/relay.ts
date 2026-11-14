/**
 * Optional relay for YouTube traffic. YouTube refuses many datacenter IPs
 * (Cloudflare Workers, cloud VMs) with "Sign in to confirm you're not a bot".
 * A relay (packages/relay) runs where YouTube trusts the address, usually a
 * home machine behind a Cloudflare Tunnel, and forwards youtube.com requests
 * byte for byte. It can also download audio with yt-dlp for speech-to-text.
 *
 *   YOUTUBE_RELAY_URL    base URL of the relay, for example https://yt-relay.example.com
 *   YOUTUBE_RELAY_TOKEN  shared secret, sent as the x-vid2context-relay-token header
 *   YOUTUBE_RELAY_MODE   fallback (default): go direct first, and through the relay
 *                        once YouTube blocks this IP (while the direct breaker is open)
 *                        always: every YouTube request goes through the relay
 *
 * The relay answers with YouTube's own status and body, so block detection
 * and the error taxonomy work unchanged. Errors of the relay itself carry the
 * header x-vid2context-relay: error and a JSON body { error: { code, message, hint } }.
 */
import { type Ctx, type Env, type ErrorCode, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { breakerRemainingSec } from './breaker.ts';

export const RELAY_TOKEN_HEADER = 'x-vid2context-relay-token';
export const RELAY_ERROR_HEADER = 'x-vid2context-relay';

/** How a request leaves: straight to YouTube, or through the relay. */
export type Route = 'direct' | 'relay';

export interface RelayConfig {
  url: string;
  token: string;
  mode: 'fallback' | 'always';
}

const RELAY_HINT = 'Check that the relay and its tunnel are running and reachable (docs/guides/youtube-relay.md).';

/** The relay settings, or undefined when no relay is configured. Throws on a half-done setup. */
export function relayConfig(env: Env): RelayConfig | undefined {
  const raw = env.YOUTUBE_RELAY_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Vid2ContextError('bad-request', `YOUTUBE_RELAY_URL is not a URL: ${raw}`, {
      hint: 'Set it to the relay base URL, for example https://yt-relay.example.com.',
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Vid2ContextError('bad-request', 'YOUTUBE_RELAY_URL must be an http(s) URL.', {
      hint: 'Use https:// for a relay behind a tunnel, or http://127.0.0.1:<port> on the same machine.',
    });
  }
  const token = env.YOUTUBE_RELAY_TOKEN?.trim();
  if (!token) {
    throw new Vid2ContextError('auth', 'YOUTUBE_RELAY_URL is set but YOUTUBE_RELAY_TOKEN is empty.', {
      hint: 'Set YOUTUBE_RELAY_TOKEN to the same secret the relay was started with (VID2CONTEXT_RELAY_TOKEN).',
    });
  }
  const mode = env.YOUTUBE_RELAY_MODE?.trim().toLowerCase() || 'fallback';
  if (mode !== 'fallback' && mode !== 'always') {
    throw new Vid2ContextError('bad-request', `YOUTUBE_RELAY_MODE must be fallback or always, not "${mode}".`, {
      hint: 'fallback goes direct first and uses the relay after a block; always sends everything through the relay.',
    });
  }
  return { url: url.href.replace(/\/+$/, ''), token, mode };
}

/** The route a new request should take: the relay when it is forced, or while YouTube blocks direct requests. */
export function chooseRoute(env: Env): Route {
  const cfg = relayConfig(env);
  if (!cfg) return 'direct';
  if (cfg.mode === 'always') return 'relay';
  return breakerRemainingSec('direct') > 0 ? 'relay' : 'direct';
}

/** True when a block on `route` can be retried through the relay. */
export function canFallBack(env: Env, route: Route): boolean {
  return route === 'direct' && relayConfig(env) !== undefined;
}

/** Suffix for attempt ids and labels, so the trace shows which requests went through the relay. */
export const routeTag = (route: Route): string => (route === 'relay' ? '@relay' : '');

function relayEndpoint(cfg: RelayConfig, path: string, params: Record<string, string>): string {
  return `${cfg.url}${path}?${new URLSearchParams(params)}`;
}

function relayHost(cfg: RelayConfig): string {
  return new URL(cfg.url).host;
}

/** Map a relay failure (its own error, not YouTube's) to a Vid2ContextError. */
async function relayError(res: Response, cfg: RelayConfig): Promise<Vid2ContextError> {
  let body: { error?: { code?: string; message?: string; hint?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // A relay error without a JSON body still has its status.
  }
  const fallback: ErrorCode = res.status === 401 ? 'auth' : res.status === 400 || res.status === 403 ? 'bad-request' : 'upstream';
  const code = (body.error?.code as ErrorCode | undefined) ?? fallback;
  return new Vid2ContextError(code, `YouTube relay ${relayHost(cfg)}: ${body.error?.message ?? `HTTP ${res.status}`}`, {
    status: res.status,
    hint: body.error?.hint ?? (res.status === 401 ? 'YOUTUBE_RELAY_TOKEN must match the relay token.' : RELAY_HINT),
  });
}

function unreachable(err: unknown, cfg: RelayConfig): Vid2ContextError {
  if (err instanceof Vid2ContextError) return err;
  const name = (err as { name?: string } | null)?.name;
  const detail = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError') return err as Vid2ContextError;
  return new Vid2ContextError(
    name === 'TimeoutError' ? 'timeout' : 'upstream',
    `YouTube relay ${relayHost(cfg)} did not answer: ${detail}`,
    { cause: err, hint: RELAY_HINT },
  );
}

/**
 * Fetch a YouTube URL on the given route. Direct is a plain fetch; relay
 * sends the same method, headers and body to <relay>/fetch?url=<target>.
 */
export async function youtubeFetch(
  ctx: Ctx,
  route: Route,
  url: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<Response> {
  if (route === 'direct') return fetchWithTimeout(ctx, url, init, timeoutMs);
  const cfg = relayConfig(ctx.env);
  if (!cfg) {
    throw new Vid2ContextError(
      'bad-request',
      'A request was routed through the YouTube relay, but YOUTUBE_RELAY_URL is not set.',
      {
        hint: 'Set YOUTUBE_RELAY_URL and YOUTUBE_RELAY_TOKEN, or unset YOUTUBE_RELAY_MODE.',
      },
    );
  }
  const headers = new Headers(init.headers);
  headers.set(RELAY_TOKEN_HEADER, cfg.token);
  let res: Response;
  try {
    res = await fetchWithTimeout(ctx, relayEndpoint(cfg, '/fetch', { url }), { ...init, headers }, timeoutMs);
  } catch (err) {
    throw unreachable(err, cfg);
  }
  if (res.headers.get(RELAY_ERROR_HEADER) === 'error') throw await relayError(res, cfg);
  return res;
}

/** Audio downloads can take minutes: yt-dlp fetches the stream and ffmpeg re-encodes it. */
const AUDIO_TIMEOUT_MS = 15 * 60_000;

/** Speech-ready audio (16 kHz mono mp3) for a YouTube video, downloaded by the relay with yt-dlp. */
export async function relayAudio(
  videoId: string,
  ctx: Ctx,
): Promise<{ data: Uint8Array; mimeType: string; filename: string; durationSec?: number }> {
  const cfg = relayConfig(ctx.env);
  if (!cfg) {
    throw new Vid2ContextError('no-provider', 'No YouTube relay is configured for audio.', {
      hint: 'Set YOUTUBE_RELAY_URL and YOUTUBE_RELAY_TOKEN (docs/guides/youtube-relay.md), or install the yt-dlp provider.',
    });
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(
      ctx,
      relayEndpoint(cfg, '/audio', { v: videoId }),
      { headers: { [RELAY_TOKEN_HEADER]: cfg.token } },
      AUDIO_TIMEOUT_MS,
    );
  } catch (err) {
    throw unreachable(err, cfg);
  }
  if (!res.ok) throw await relayError(res, cfg);
  const data = new Uint8Array(await res.arrayBuffer());
  const duration = Number(res.headers.get('x-duration-sec'));
  return {
    data,
    mimeType: res.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/mpeg',
    filename: `${videoId}.mp3`,
    ...(Number.isFinite(duration) && duration > 0 ? { durationSec: duration } : {}),
  };
}
