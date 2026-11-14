/**
 * The innertube player call, with ordered fallback across player clients and
 * a short per-process cache.
 *
 * Each client is tried in order (see clients.ts). The next client gets a turn
 * when the current one is refused for client reasons (LOGIN_REQUIRED without
 * a video reason, UNPLAYABLE "The page needs to be reloaded", "no longer
 * supported"), gets the bot check (other clients often still pass from the
 * same IP: on 2026-11-14 ANDROID_VR got it while ANDROID and IOS did not),
 * returns no captions, or fails with an HTTP error other than a block.
 * A verdict about the video itself (removed, private, members-only, upcoming)
 * ends the search: no client does better.
 */
import { type Attempt, type Ctx, type Env, Vid2ContextError } from '@vid2context/core';
import { tripBreaker } from './breaker.ts';
import { type ClientSpec, resolveClients } from './clients.ts';
import { classifyPlayability, type PlayabilityStatus } from './errors.ts';
import { innertubeRequest } from './transport.ts';

export interface RawCaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
  vssId?: string;
  isTranslatable?: boolean;
}

export interface TranslationLanguage {
  languageCode: string;
  languageName?: { simpleText?: string; runs?: { text: string }[] };
}

export interface PlayerResponse {
  playabilityStatus?: PlayabilityStatus;
  videoDetails?: {
    videoId: string;
    title?: string;
    lengthSeconds?: string;
    keywords?: string[];
    channelId?: string;
    shortDescription?: string;
    thumbnail?: { thumbnails?: { url: string; width?: number; height?: number }[] };
    viewCount?: string;
    author?: string;
    isLiveContent?: boolean;
    isLive?: boolean;
    isPrivate?: boolean;
    isUpcoming?: boolean;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: RawCaptionTrack[];
      audioTracks?: { captionTrackIndices?: number[]; defaultCaptionTrackIndex?: number; audioTrackId?: string }[];
      translationLanguages?: TranslationLanguage[];
    };
  };
  /** Added by vid2context, not YouTube: the innertube client that produced this response. */
  client?: string;
  /** Added by vid2context, not YouTube: one entry per client tried. */
  attempts?: Attempt[];
}

const errInfo = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

function asYouTubeError(err: unknown): Vid2ContextError {
  if (err instanceof Vid2ContextError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError')
    return new Vid2ContextError('timeout', `YouTube player: ${errInfo(err)}`, {
      hint: 'YouTube did not answer in time. Check the network and retry.',
    });
  return new Vid2ContextError('upstream', `YouTube player: ${errInfo(err)}`, {
    cause: err,
    hint: 'Check the network and retry.',
  });
}

function playerBody(videoId: string, ctx: Ctx): Record<string, unknown> {
  const poToken = ctx.env.YOUTUBE_PO_TOKEN?.trim();
  return {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    ...(poToken ? { serviceIntegrityDimensions: { poToken } } : {}),
  };
}

function tag(player: PlayerResponse, client: ClientSpec, attempts: Attempt[]): PlayerResponse {
  return Object.assign(player, { client: client.clientName, attempts });
}

/** POST /youtubei/v1/player, falling back across the configured clients. */
export async function fetchPlayer(videoId: string, ctx: Ctx): Promise<PlayerResponse> {
  const clients = resolveClients(ctx.env);
  const attempts: Attempt[] = [];
  const failures: Vid2ContextError[] = [];
  let withoutCaptions: { player: PlayerResponse; client: ClientSpec } | undefined;

  for (const client of clients) {
    const id = `youtube/${client.key}`;
    const started = Date.now();
    const ms = () => Date.now() - started;
    let player: PlayerResponse;
    try {
      player = await innertubeRequest<PlayerResponse>('player', playerBody(videoId, ctx), client, ctx);
    } catch (err) {
      const e = asYouTubeError(err);
      attempts.push({ id, stage: 'metadata', outcome: 'error', reason: e.code, detail: errInfo(e), ms: ms() });
      // A block or an open breaker is about the IP, not the client; an abort is the caller's decision.
      // A playable answer already in hand (only its captions were missing) is still worth returning.
      if (e.code === 'blocked' && withoutCaptions && !ctx.signal?.aborted) break;
      if (e.code === 'blocked' || ctx.signal?.aborted || e.code === 'bad-request') {
        throw Object.assign(e, { attempts: [...((e as { attempts?: Attempt[] }).attempts ?? []), ...attempts] });
      }
      failures.push(e);
      ctx.log.debug('youtube: player client failed, trying the next', { client: client.key, code: e.code });
      continue;
    }

    const p = classifyPlayability(player.playabilityStatus, videoId);
    if (p.kind === 'ok') {
      if (!player.captions && player.videoDetails && !player.videoDetails.isLive) {
        attempts.push({ id, stage: 'metadata', outcome: 'empty', reason: 'no-captions', ms: ms() });
        withoutCaptions ??= { player, client };
        continue;
      }
      attempts.push({ id, stage: 'metadata', outcome: 'ok', ms: ms() });
      ctx.log.debug('youtube: player ok', { client: client.key });
      return tag(player, client, attempts);
    }
    const status = player.playabilityStatus?.status ?? '';
    if (p.kind === 'final') {
      attempts.push({ id, stage: 'metadata', outcome: 'error', reason: p.error.code, detail: status, ms: ms() });
      return tag(player, client, attempts);
    }
    attempts.push({
      id,
      stage: 'metadata',
      outcome: 'error',
      reason: p.kind === 'bot' ? 'bot-check' : 'client-refused',
      detail: `${status}: ${player.playabilityStatus?.reason ?? ''}`.slice(0, 200),
      ms: ms(),
    });
    failures.push(p.error);
    ctx.log.debug('youtube: player client refused, trying the next', { client: client.key, status });
  }

  // A playable response without captions from every client: the video has none.
  if (withoutCaptions) return tag(withoutCaptions.player, withoutCaptions.client, attempts);

  const tried = attempts.map((a) => `${a.id.slice('youtube/'.length)}: ${a.detail ?? a.reason}`).join('; ');
  const allBot = failures.length > 0 && failures.every((f) => f.code === 'blocked');
  const last = failures.at(-1) ?? new Vid2ContextError('upstream', 'no client answered');
  const pick = allBot ? last : (failures.filter((f) => f.code !== 'blocked').at(-1) ?? last);
  const err = new Vid2ContextError(pick.code, `YouTube player ${videoId}: every client failed (${tried})`, {
    hint: pick.hint,
    status: pick.status,
    retryAfterSec: pick.retryAfterSec,
  });
  if (allBot) tripBreaker(err, ctx);
  throw Object.assign(err, { attempts });
}

const TTL_MS = 60_000;

/**
 * Player responses cached per video id for 60 seconds, so a metadata call and
 * a captions call in one request (or two quick requests) share one response.
 * The cache is keyed by the ctx.env object: the Node surfaces pass the same
 * process.env to every context, so it is process-wide there, while each test
 * context (a fresh env) starts empty. Failures are not cached.
 */
const cache = new WeakMap<Env, Map<string, { at: number; pending: Promise<PlayerResponse> }>>();

export function getPlayer(videoId: string, ctx: Ctx): Promise<PlayerResponse> {
  let byId = cache.get(ctx.env);
  if (!byId) {
    byId = new Map();
    cache.set(ctx.env, byId);
  }
  const hit = byId.get(videoId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.pending;
  const pending = fetchPlayer(videoId, ctx);
  const entry = { at: Date.now(), pending };
  byId.set(videoId, entry);
  const map = byId;
  pending.catch(() => {
    if (map.get(videoId) === entry) map.delete(videoId);
  });
  return pending;
}

/** Drop the cached player responses for this context's env. */
export function clearPlayerCache(ctx: Ctx): void {
  cache.delete(ctx.env);
}
