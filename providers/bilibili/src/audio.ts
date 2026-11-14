/**
 * Audio for speech-to-text. The playurl API (DASH, fnval=16) lists audio-only
 * streams (fragmented MP4, AAC). Bilibili's media hosts answer 403 without a
 * www.bilibili.com Referer, which speech-to-text rungs cannot send when they
 * download a { kind: 'url' } input, so this downloads the smallest audio
 * stream itself and returns bytes, capped at BILIBILI_MAX_AUDIO_MB (default 50).
 */
import { type AudioInput, type Ctx, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { type DashStream, getPlayurl, type Part, REFERER, USER_AGENT } from './api.ts';

const MB = 1024 * 1024;
export const DEFAULT_MAX_AUDIO_MB = 50;

export function maxAudioBytes(ctx: Ctx): number {
  const mb = Number(ctx.env.BILIBILI_MAX_AUDIO_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_AUDIO_MB) * MB;
}

function tooLarge(what: string, bytes: number, limit: number): Vid2ContextError {
  return new Vid2ContextError(
    'too-large',
    `${what} is ${(bytes / MB).toFixed(1)} MB; BILIBILI_MAX_AUDIO_MB allows ${(limit / MB).toFixed(0)} MB.`,
    {
      hint: 'Raise BILIBILI_MAX_AUDIO_MB if your speech-to-text rung (or long-audio splitting) can take more, or pick a shorter part with ?p=.',
    },
  );
}

function urlsOf(s: DashStream): string[] {
  return [s.baseUrl ?? s.base_url, ...(s.backupUrl ?? s.backup_url ?? [])].filter((u): u is string => Boolean(u));
}

/** Read a response body, aborting as soon as it passes the limit. */
async function readCapped(res: Response, limit: number, what: string): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(what, total, limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function downloadAudio(part: Part, ctx: Ctx): Promise<AudioInput> {
  const play = await getPlayurl(ctx, part.bvid, part.cid);
  const streams = [...(play.dash?.audio ?? [])].sort((a, b) => a.bandwidth - b.bandwidth);
  const stream = streams[0];
  if (!stream) {
    throw new Vid2ContextError('unavailable', `Bilibili offers no separate audio stream for ${part.bvid} part ${part.page}.`, {
      hint: 'Only DASH audio is downloaded (never video). The yt-dlp provider can extract audio from the combined stream on Node.',
    });
  }
  const durationSec = play.dash?.duration ?? (play.timelength ? play.timelength / 1000 : part.pageInfo?.duration);
  const limit = maxAudioBytes(ctx);
  const label = `The audio of ${part.bvid}${part.page > 1 ? ` part ${part.page}` : ''}`;
  if (durationSec && (stream.bandwidth / 8) * durationSec > limit)
    throw tooLarge(label, (stream.bandwidth / 8) * durationSec, limit);

  let lastError: unknown;
  for (const url of urlsOf(stream)) {
    try {
      // Long timeout: the download is the whole audio track.
      const res = await fetchWithTimeout(ctx, url, { headers: { 'user-agent': USER_AGENT, referer: REFERER } }, 300_000);
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Vid2ContextError(
          res.status === 403 ? 'auth' : 'upstream',
          `Bilibili audio host ${new URL(url).host}: HTTP ${res.status}`,
          {
            status: res.status,
          },
        );
      }
      const length = Number(res.headers.get('content-length'));
      if (Number.isFinite(length) && length > limit) {
        await res.body?.cancel().catch(() => undefined);
        throw tooLarge(label, length, limit);
      }
      const data = await readCapped(res, limit, label);
      return {
        kind: 'bytes',
        data,
        mimeType: 'audio/mp4',
        filename: `${part.bvid}${part.page > 1 ? `_p${part.page}` : ''}.m4a`,
        ...(durationSec ? { durationSec } : {}),
      };
    } catch (err) {
      if (err instanceof Vid2ContextError && err.code === 'too-large') throw err;
      lastError = err;
      ctx.log.debug('bilibili audio host failed, trying a backup', { host: new URL(url).host, error: String(err) });
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Vid2ContextError('upstream', `Could not download the audio of ${part.bvid}.`);
}
