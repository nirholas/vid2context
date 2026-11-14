/**
 * Download one caption track. srv3 first (word timing for auto-captions,
 * single-encoded entities), then the endpoint's default srv1. Whatever comes
 * back is parsed by its detected format, so a json3 or VTT body also works.
 *
 * A 403 on every attempt means the IP or the signed URL is refused, which is
 * a block: the breaker opens. An empty body means YouTube wants a
 * proof-of-origin token for this client.
 */
import { type Ctx, type Segment, Vid2ContextError } from '@vid2context/core';
import { tripBreaker } from '../resilience/breaker.ts';
import { BLOCKED_HINT } from '../resilience/errors.ts';
import type { RawCaptionTrack } from '../resilience/player.ts';
import { youtubeGet } from '../resilience/transport.ts';
import { parseTimedText } from './formats.ts';

/** fmt values tried in order; null means no fmt parameter (srv1). */
const FORMATS = ['srv3', null] as const;

export function trackUrl(track: RawCaptionTrack, ctx: Ctx, fmt: string | null, translateTo?: string, client?: string): string {
  const url = new URL(track.baseUrl);
  if (fmt) url.searchParams.set('fmt', fmt);
  else url.searchParams.delete('fmt');
  if (translateTo) url.searchParams.set('tlang', translateTo);
  const pot = ctx.env.YOUTUBE_PO_TOKEN?.trim();
  if (pot) {
    url.searchParams.set('pot', pot);
    if (client) url.searchParams.set('c', client);
  }
  return url.href;
}

/**
 * Fetch and parse a track. `client` is the innertube clientName that produced
 * the track list (sent with a PO token, which is bound to a client).
 */
export async function fetchTrack(track: RawCaptionTrack, ctx: Ctx, translateTo?: string, client?: string): Promise<Segment[]> {
  const label = `YouTube captions ${track.languageCode}${translateTo ? `->${translateTo}` : ''}`;
  let forbidden = 0;
  for (const fmt of FORMATS) {
    let res: Response;
    try {
      res = await youtubeGet(trackUrl(track, ctx, fmt, translateTo, client), ctx, label);
    } catch (err) {
      if (err instanceof Vid2ContextError && err.status === 403) {
        forbidden++;
        continue;
      }
      throw err;
    }
    const segments = parseTimedText(await res.text());
    if (segments.length > 0) return segments;
  }
  if (forbidden === FORMATS.length) {
    const err = new Vid2ContextError('blocked', `${label}: YouTube answered HTTP 403 to every caption request.`, {
      status: 403,
      hint: BLOCKED_HINT,
    });
    tripBreaker(err, ctx, 'direct', 'timedtext');
    throw err;
  }
  throw new Vid2ContextError('upstream', `${label}: the caption payload was empty.`, {
    hint:
      'YouTube returned an empty track, which happens when it wants a proof-of-origin token for this client. ' +
      'Set YOUTUBE_PO_TOKEN and YOUTUBE_VISITOR_DATA (docs/guides/youtube.md), retry later, or use --mode stt.',
  });
}
