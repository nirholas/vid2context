/**
 * LIVE=1 only: follow a real live stream for two minutes through the real
 * services (YouTube, the configured speech-to-text rungs, ffmpeg) and print
 * the lines produced and the lag, measured as wall clock minus the stream's
 * program date time of each line. Defaults to NASA's public-domain ISS
 * stream; set VID2CONTEXT_LIVE_TEST_URL to follow another one. Uses the
 * Workers AI rung when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set,
 * else the keyless OVH rung.
 */
import { createContext, Registry } from '@vid2context/core';
import cloudflare from '@vid2context/provider-cloudflare-ai';
import stt from '@vid2context/provider-stt-openai-compatible';
import { describe, expect, it } from 'vitest';
import { createFfmpegExtractor, ffmpegAvailable } from '../src/ffmpeg.ts';
import { formatLiveLine } from '../src/format.ts';
import type { LiveEvent } from '../src/types.ts';
import { watchLive } from '../src/watch.ts';
import { NASA_URL } from './scenarios.ts';

const env = { ...process.env };

describe.skipIf(!process.env.LIVE || !ffmpegAvailable(env))('live stream (LIVE=1)', () => {
  it('follows a real live stream for two minutes', async () => {
    const url = process.env.VID2CONTEXT_LIVE_TEST_URL || NASA_URL;
    const ctx = createContext({ runtime: 'node', env });
    const started = Date.now();
    const events: LiveEvent[] = [];
    const lags: number[] = [];
    for await (const e of watchLive(
      url,
      { maxMinutes: 2 },
      { registry: new Registry([...[cloudflare].flat(), stt], 'node'), ctx, extractAudio: createFfmpegExtractor({ env }) },
    )) {
      events.push(e);
      const t = ((Date.now() - started) / 1000).toFixed(1);
      if (e.type === 'segment') {
        const lag = e.at ? (Date.now() - Date.parse(e.at)) / 1000 : Number.NaN;
        if (Number.isFinite(lag)) lags.push(lag);
        console.error(`${t}s lag ${lag.toFixed(1)}s ${formatLiveLine(e)}`);
      } else if (e.type === 'status') console.error(`${t}s status ${e.code}: ${e.message}`);
      else console.error(`${t}s done ${e.reason}: ${e.transcript.segments.length} segments by ${e.transcript.producer}`);
    }
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    // Either a chunk was transcribed, or the statuses say why not (a saturated keyless quota, for example).
    expect(events.some((e) => e.type === 'status' && (e.code === 'rung' || e.code === 'stt-retry'))).toBe(true);
    if (lags.length > 0) {
      const avg = lags.reduce((a, b) => a + b, 0) / lags.length;
      console.error(
        `lines: ${lags.length}, lag min ${Math.min(...lags).toFixed(1)}s, avg ${avg.toFixed(1)}s, max ${Math.max(...lags).toFixed(1)}s`,
      );
    }
  }, 330_000);
});
