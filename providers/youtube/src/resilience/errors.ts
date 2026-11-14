/**
 * YouTube error taxonomy. Every playability status and HTTP failure maps to a
 * stable Vid2ContextError code with a hint that says how to recover. The
 * reason strings matched here are the ones in the real recordings under
 * test/fixtures/ (2026-11-14).
 *
 *   not-found    removed, private, invalid id
 *   unavailable  age-restricted, members-only, region-blocked, live not ended, upcoming
 *   blocked      "Sign in to confirm you're not a bot" on every client, the 429
 *                "automated queries" page, repeated 403s on timedtext
 *   rate-limited 429 from the API that is not the block page
 */
import { errorFromResponse, Vid2ContextError } from '@vid2context/core';

export const BLOCKED_HINT =
  'YouTube is refusing requests from this IP address, which is common on cloud servers. Fixes, best first: ' +
  'run vid2context on your own machine; route the server through your home network (docs/guides/cloudflare-tunnel.md); ' +
  'set YOUTUBE_COOKIE to a signed-in Cookie header (ties requests to your account); ' +
  'or install the yt-dlp provider. Then wait for the block to clear (YOUTUBE_BLOCK_COOLDOWN_SEC).';

const CLIENT_HINT =
  'Every YouTube player client was rejected, which usually means YouTube changed its clients. ' +
  'Set YOUTUBE_CLIENTS or a newer YOUTUBE_<CLIENT>_VERSION (see docs/guides/youtube.md), or update vid2context.';

export interface PlayabilityStatus {
  status?: string;
  reason?: string;
  liveStreamability?: {
    liveStreamabilityRenderer?: {
      offlineSlate?: { liveStreamOfflineSlateRenderer?: { scheduledStartTime?: string } };
    };
  };
}

/**
 * How a player response should be treated:
 *   ok      playable
 *   client  this client was refused; another client may work
 *   bot     this client got the bot check; another client may still pass
 *   final   a fact about the video (removed, private, members-only...); no client will do better
 */
export type Playability =
  | { kind: 'ok' }
  | { kind: 'client'; error: Vid2ContextError }
  | { kind: 'bot'; error: Vid2ContextError }
  | { kind: 'final'; error: Vid2ContextError };

function scheduledStart(ps: PlayabilityStatus): string | undefined {
  const sec = Number(ps.liveStreamability?.liveStreamabilityRenderer?.offlineSlate?.liveStreamOfflineSlateRenderer?.scheduledStartTime);
  return Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : undefined;
}

export function classifyPlayability(ps: PlayabilityStatus | undefined, videoId: string): Playability {
  const status = ps?.status ?? 'OK';
  if (status === 'OK') return { kind: 'ok' };
  const reason = (ps?.reason ?? '').replace(/’/g, "'");
  const msg = `YouTube ${videoId}: ${status}${reason ? ` (${reason})` : ''}`;
  const final = (code: 'not-found' | 'unavailable', hint: string): Playability => ({
    kind: 'final',
    error: new Vid2ContextError(code, msg, { hint }),
  });

  if (/not a bot/i.test(reason)) return { kind: 'bot', error: new Vid2ContextError('blocked', msg, { hint: BLOCKED_HINT }) };
  if (/\bprivate\b/i.test(reason)) {
    return final('not-found', 'This video is private. Only the owner or invited accounts can see it.');
  }
  if (status === 'AGE_CHECK_REQUIRED' || status === 'AGE_VERIFICATION_REQUIRED' || /inappropriate|age.?restrict|confirm your age/i.test(reason)) {
    return final(
      'unavailable',
      'This video is age-restricted and needs a signed-in, age-verified session: set YOUTUBE_COOKIE, or use the yt-dlp provider with your cookies.',
    );
  }
  if (/members|join this channel/i.test(reason)) {
    return final('unavailable', "This video is for the channel's paying members only. A member's YOUTUBE_COOKIE can unlock it.");
  }
  if (/country|region|your location/i.test(reason)) {
    return final('unavailable', 'This video is blocked in the region of this IP address. Run vid2context from a region where it plays.');
  }
  if (status === 'LIVE_STREAM_OFFLINE') {
    const at = scheduledStart(ps ?? {});
    return final(
      'unavailable',
      at
        ? `This live stream or premiere has not started; it is scheduled for ${at}. Try again after it ends.`
        : 'This live stream or premiere has not started yet. Try again after it ends.',
    );
  }
  if (status === 'CONTENT_CHECK_REQUIRED') {
    return final('unavailable', 'YouTube shows a content warning for this video and needs a signed-in session: set YOUTUBE_COOKIE.');
  }
  if (status === 'ERROR' && /no longer supported|application or device/i.test(reason)) {
    return { kind: 'client', error: new Vid2ContextError('upstream', msg, { hint: CLIENT_HINT }) };
  }
  if (status === 'ERROR') {
    return final('not-found', 'The video does not exist or was removed. Check the video id or URL.');
  }
  // LOGIN_REQUIRED without a video reason ("Please sign in"), UNPLAYABLE "The page needs to be reloaded"
  // and other unknown states: specific to the client, so the next client gets a turn.
  return { kind: 'client', error: new Vid2ContextError('unavailable', msg, { hint: CLIENT_HINT }) };
}

/** Turn a non-OK playabilityStatus into an error. Returns null when the video is playable. */
export function playabilityError(player: { playabilityStatus?: PlayabilityStatus }, videoId: string): Vid2ContextError | null {
  const p = classifyPlayability(player.playabilityStatus, videoId);
  return p.kind === 'ok' ? null : p.error;
}

/** The 429 page YouTube serves to flagged IPs ("Sorry... your computer or network may be sending automated queries"). */
export function isBlockPage(body: string): boolean {
  return /automated queries|unusual traffic|<title>Sorry\.\.\.<\/title>/i.test(body);
}

/** Map a YouTube rate-limit page or HTTP error to a Vid2ContextError. */
export async function youtubeHttpError(res: Response, label: string): Promise<Vid2ContextError> {
  if (res.status === 429) {
    const body = await res
      .clone()
      .text()
      .catch(() => '');
    if (isBlockPage(body)) {
      return new Vid2ContextError('blocked', `${label}: YouTube answered HTTP 429 (automated-traffic block).`, {
        status: 429,
        hint: BLOCKED_HINT,
      });
    }
    const err = await errorFromResponse(res, label);
    return new Vid2ContextError('rate-limited', err.message, {
      status: 429,
      retryAfterSec: err.retryAfterSec,
      hint: 'YouTube is rate-limiting this IP. Wait a minute and retry; heavy batch jobs should slow down.',
    });
  }
  const err = await errorFromResponse(res, label);
  return err.hint ? err : new Vid2ContextError(err.code, err.message, { status: err.status, retryAfterSec: err.retryAfterSec, hint: hintFor(err.code) });
}

function hintFor(code: string): string {
  if (code === 'auth') return 'YouTube refused the request (HTTP 401/403). If it repeats, this IP may be blocked: see docs/guides/youtube.md.';
  if (code === 'not-found') return 'YouTube returned 404. Check the video id or URL.';
  return 'YouTube returned an unexpected error. Retry later; if it persists, see docs/guides/youtube.md.';
}
