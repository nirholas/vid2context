/**
 * Audio for speech-to-text, without ffmpeg.
 *
 * X's HLS master playlist for a video lists audio-only renditions (AAC at
 * 32, 64 and 128 kbps) as fragmented MP4: one init segment plus 3-second
 * `.m4s` fragments. The init segment followed by every fragment, in order,
 * is a valid .m4a file, so the lowest-bitrate rendition is downloaded and
 * joined here with plain fetch (Node and Workers). That is about a quarter
 * of the smallest MP4 rendition, and audio-only, which some speech-to-text
 * services need (OVH's keyless lane misreads the length of X's MP4 files).
 *
 * When the post has no usable HLS audio (no playlist, encryption, an
 * unexpected layout, a segment that fails twice), the smallest MP4
 * rendition is downloaded instead.
 * Both paths stop at VID2CONTEXT_MAX_MEDIA_MB.
 */
import { type AudioInput, type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { fetchMedia, maxMediaBytes } from '@vid2context/provider-media-url';
import type { XMedia } from './post.ts';

const MB = 1024 * 1024;
const CONCURRENCY = 6;
const SEGMENT_TIMEOUT_MS = 30_000;
const SEGMENT_ATTEMPTS = 2;
const HINT = 'Raise VID2CONTEXT_MAX_MEDIA_MB; this is already the smallest audio X serves.';

export interface HlsAudio {
  /** Bits per second of the chosen rendition. */
  bitrate: number;
  /** Init segment first, then every fragment, as absolute URLs. */
  urls: string[];
  durationSec: number;
}

/** Audio renditions in a master playlist, lowest bitrate first. */
export function audioRenditions(master: string, base: string): { bitrate: number; url: string }[] {
  const out: { bitrate: number; url: string }[] = [];
  for (const line of master.split('\n')) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=AUDIO/.test(line)) continue;
    const uri = /URI="([^"]+)"/.exec(line)?.[1];
    if (!uri) continue;
    const bits = /GROUP-ID="[^"]*?(\d{4,7})"/.exec(line)?.[1] ?? /\/mp4a\/(\d{4,7})\//.exec(uri)?.[1];
    out.push({ bitrate: bits ? Number(bits) : Number.POSITIVE_INFINITY, url: new URL(uri, base).href });
  }
  return out.sort((a, b) => a.bitrate - b.bitrate);
}

/** Init segment and fragments of a media playlist; null when it is not plain fragmented MP4. */
export function mediaSegments(playlist: string, base: string): { urls: string[]; durationSec: number } | null {
  if (/#EXT-X-KEY:(?!METHOD=NONE)/.test(playlist)) return null;
  const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)?.[1];
  if (!map) return null;
  const urls = [new URL(map, base).href];
  let durationSec = 0;
  for (const raw of playlist.split('\n')) {
    const line = raw.trim();
    const inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (inf?.[1]) durationSec += Number(inf[1]);
    else if (line && !line.startsWith('#')) urls.push(new URL(line, base).href);
  }
  return urls.length > 1 ? { urls, durationSec } : null;
}

async function text(url: string, ctx: Ctx, label: string): Promise<string> {
  const res = await fetchWithTimeout(ctx, url);
  if (!res.ok) throw await errorFromResponse(res, label);
  return res.text();
}

/** The lowest-bitrate audio rendition of an HLS master playlist, or null when there is none to use. */
export async function hlsAudio(masterUrl: string, ctx: Ctx): Promise<HlsAudio | null> {
  const lowest = audioRenditions(await text(masterUrl, ctx, 'X HLS playlist'), masterUrl)[0];
  if (!lowest) return null;
  const segments = mediaSegments(await text(lowest.url, ctx, 'X HLS audio playlist'), lowest.url);
  return segments ? { bitrate: lowest.bitrate, ...segments } : null;
}

function tooLarge(what: string, bytes: number, cap: number): Vid2ContextError {
  return new Vid2ContextError(
    'too-large',
    `${what} is about ${(bytes / MB).toFixed(1)} MB; VID2CONTEXT_MAX_MEDIA_MB allows ${(cap / MB).toFixed(0)} MB.`,
    { hint: HINT },
  );
}

/** A 5xx, a 429 or a network error is worth one more try; a 403 or 404 is not. */
function retryable(err: unknown): boolean {
  if (!(err instanceof Vid2ContextError)) return true;
  return err.code === 'upstream' || err.code === 'rate-limited' || err.code === 'timeout';
}

async function fetchSegment(url: string, ctx: Ctx): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchWithTimeout(ctx, url, {}, SEGMENT_TIMEOUT_MS);
      if (!res.ok) throw await errorFromResponse(res, 'X HLS segment');
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= SEGMENT_ATTEMPTS || ctx.signal?.aborted || !retryable(err)) throw err;
      ctx.log.debug('x HLS segment failed, retrying', { attempt, error: String(err) });
    }
  }
}

/**
 * Download segments a few at a time and join them in order. Stops as soon as
 * the total passes the cap, a segment fails twice, or ctx.signal aborts; the
 * other workers stop at their next segment instead of downloading the rest.
 */
export async function downloadSegments(urls: string[], ctx: Ctx, cap: number, what: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = new Array(urls.length);
  let total = 0;
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < urls.length && !failed) {
      if (ctx.signal?.aborted) throw new Vid2ContextError('timeout', `Stopped downloading ${what}: the request was cancelled.`);
      const i = next++;
      try {
        const data = await fetchSegment(urls[i] as string, ctx);
        total += data.byteLength;
        if (total > cap) throw tooLarge(what, total, cap);
        parts[i] = data;
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export async function downloadAudio(media: XMedia, ctx: Ctx, name: string, what: string): Promise<AudioInput> {
  const cap = maxMediaBytes(ctx.env);
  if (media.hls) {
    let hls: HlsAudio | null = null;
    try {
      hls = await hlsAudio(media.hls, ctx);
    } catch (err) {
      ctx.log.debug('x HLS audio playlist failed, using the MP4', { error: String(err) });
    }
    if (hls) {
      const durationSec = media.durationSec ?? hls.durationSec;
      if (Number.isFinite(hls.bitrate) && (hls.bitrate / 8) * durationSec > cap)
        throw tooLarge(what, (hls.bitrate / 8) * durationSec, cap);
      try {
        const data = await downloadSegments(hls.urls, ctx, cap, what);
        return { kind: 'bytes', data, mimeType: 'audio/mp4', filename: `${name}.m4a`, durationSec };
      } catch (err) {
        // Too large or cancelled stays final; a broken segment falls back to the single MP4 file.
        if (ctx.signal?.aborted || (err instanceof Vid2ContextError && err.code === 'too-large')) throw err;
        ctx.log.debug('x HLS audio download failed, using the MP4', { error: String(err) });
      }
    }
  }
  // Every MP4 rendition carries the same audio track, so the smallest one is downloaded.
  const smallest = media.variants[media.variants.length - 1];
  if (!smallest) {
    throw new Vid2ContextError('unavailable', `X lists no audio or MP4 rendition for ${what}.`, {
      hint: 'On Node, the yt-dlp provider can read the stream instead.',
    });
  }
  if (smallest.bitrate && media.durationSec && (smallest.bitrate / 8) * media.durationSec > cap)
    throw tooLarge(what, (smallest.bitrate / 8) * media.durationSec, cap);
  const { data } = await fetchMedia(smallest.url, ctx, { maxBytes: cap, hint: HINT });
  return {
    kind: 'bytes',
    data,
    mimeType: 'video/mp4',
    filename: `${name}.mp4`,
    ...(media.durationSec ? { durationSec: media.durationSec } : {}),
  };
}
