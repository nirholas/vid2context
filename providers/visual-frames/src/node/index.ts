/**
 * `@vid2context/provider-visual-frames/node`: the frame pipeline (Node only).
 * Edge builds never import this subpath.
 *
 *   extractVisualNotes(input, opts, ctx)
 *     input    a local video file, a file:// URL, or an http(s) URL yt-dlp can download
 *     1. sample frames at scene changes with interval limits (ffmpeg)
 *     2. collapse consecutive look-alikes by dHash, keep the sharpest of each run
 *     3. keep at most maxFrames: biggest changes, spread across the duration
 *     4. read each frame through the visual rung chain (runChain), free first
 *     5. sort notes by time and merge consecutive near-identical text
 *
 * Keyless OVH allows about 2 requests a minute. Its rung spaces requests and
 * the chain moves on; when every rung is resting, the pipeline waits for the
 * next slot (up to maxWaitSec) instead of dropping the frame.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Attempt,
  attemptsOf,
  type ChainOptions,
  type Ctx,
  rankRungs,
  runChain,
  Vid2ContextError,
  type VisualNote,
  type VisualRung,
} from '@vid2context/core';
import { dataHome } from '@vid2context/ffmpeg';
import { nodeLangSource } from '../node-provider.ts';
import { visualRungs } from '../provider.ts';
import { DEFAULT_HASH_THRESHOLD, dedupeFrames, mergeNotes, selectBudget } from '../select.ts';
import { terminateTesseract } from '../tesseract.ts';
import { throttleRemainingMs } from '../throttle.ts';
import { downloadVideo } from './download.ts';
import { resolveSampleOptions, type SampleOptions, sampleFrames } from './sample.ts';

export { commonArgs, downloadArgs, downloadVideo, VIDEO_FORMAT } from './download.ts';
export { framesFromThumbs, parseDuration, resolveSampleOptions, SAMPLE_DEFAULTS, type SampleOptions, type SampledFrames, sampleFrames, samplingArgs, selectExpression } from './sample.ts';

export interface ExtractVisualOptions extends SampleOptions {
  /** Most frames sent to rungs. Default 40. */
  maxFrames?: number;
  /** dHash Hamming distance (of 64 bits) at or under which consecutive frames are the same picture. Default 10. */
  hashThreshold?: number;
  /** Chain options for the visual rungs (policy, only, skip, needs). */
  chain?: ChainOptions;
  /** Visual rungs to use. Default: this package's rungs; pass `registry.visualRungs(env)` to include every visual provider. */
  rungs?: VisualRung[];
  /** Longest wait for a rate-limited rung when no other rung can read a frame. Default 120 s; 0 skips the frame instead. */
  maxWaitSec?: number;
}

export interface VisualFrameInfo {
  /** When the picture first appeared. */
  atSec: number;
  /** dHash, 16 hex characters. */
  hash: string;
  /** The rung that read the frame; absent when every rung failed. */
  sentTo?: string;
}

export interface ExtractVisualResult {
  notes: VisualNote[];
  /** The distinct frames that were sent to rungs, in time order. */
  frames: VisualFrameInfo[];
  attempts: Attempt[];
  durationSec?: number;
}

export const DEFAULT_MAX_FRAMES = 40;
const DEFAULT_MAX_WAIT_SEC = 120;
const MAX_RETRIES_PER_FRAME = 3;
/** Core cools a rate-limited rung for 60 s when the service gives no Retry-After. */
const UNKNOWN_COOLDOWN_MS = 60_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** True when a failed chain run only met resting rungs (throttled or rate-limited), so waiting can help. */
export function onlyRateLimited(attempts: Attempt[]): boolean {
  return (
    attempts.length > 0 &&
    attempts.every((a) => (a.outcome === 'skipped' && a.reason === 'cooldown') || a.reason?.startsWith('rate-limited'))
  );
}

function localPath(input: string): string {
  return /^file:\/\//i.test(input) ? fileURLToPath(input) : input;
}

export async function extractVisualNotes(input: string, opts: ExtractVisualOptions, ctx: Ctx): Promise<ExtractVisualResult> {
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  if (!Number.isInteger(maxFrames) || maxFrames < 1) {
    throw new Vid2ContextError('bad-request', `maxFrames must be a positive integer, got ${maxFrames}.`, { hint: 'Pass maxFrames: 40, for example.' });
  }
  const hashThreshold = opts.hashThreshold ?? DEFAULT_HASH_THRESHOLD;
  if (!Number.isInteger(hashThreshold) || hashThreshold < 0 || hashThreshold > 64) {
    throw new Vid2ContextError('bad-request', `hashThreshold must be an integer from 0 to 64, got ${hashThreshold}.`, { hint: 'The default is 10.' });
  }
  const sample = resolveSampleOptions(opts);
  const chain = opts.chain ?? {};
  const maxWaitMs = Math.max(0, opts.maxWaitSec ?? DEFAULT_MAX_WAIT_SEC) * 1000;
  const rungs = opts.rungs ?? visualRungs(ctx.env, nodeLangSource);
  if (rankRungs(rungs, chain, ctx.env).length === 0) {
    throw new Vid2ContextError('no-provider', 'No visual rung is enabled, so no frame could be read.', {
      hint: 'Leave TESSERACT_ENABLED unset (local OCR), set OLLAMA_VISION_MODEL or GEMINI_API_KEY, or allow keyless OVH (unset VID2CONTEXT_KEYLESS=0). The local-only policy needs tesseract or Ollama.',
    });
  }

  const tmp = join(dataHome(ctx.env), 'cache', `visual-${randomUUID()}`);
  const framesDir = join(tmp, 'frames');
  await mkdir(framesDir, { recursive: true });
  try {
    const source = /^https?:\/\//i.test(input) ? await downloadVideo(input, tmp, ctx) : localPath(input);
    const sampled = await sampleFrames(source, framesDir, sample, ctx);
    const distinct = dedupeFrames(sampled.frames, hashThreshold);
    const chosen = selectBudget(distinct, maxFrames, sampled.durationSec);
    ctx.log.info('visual frames', { sampled: sampled.frames.length, distinct: distinct.length, reading: chosen.length });

    const notes: VisualNote[] = [];
    const frames: VisualFrameInfo[] = [];
    const attempts: Attempt[] = [];
    let lastError: unknown;
    for (const [i, d] of chosen.entries()) {
      const file = sampled.files[d.best.index];
      if (!file) continue;
      const frame = { data: new Uint8Array(await readFile(file)), mimeType: 'image/jpeg', atSec: d.atSec };
      const info: VisualFrameInfo = { atSec: d.atSec, hash: d.hash };
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await runChain('visual', rungs, (rung) => rung.read(frame, ctx), chain, ctx);
          attempts.push(...res.attempts);
          notes.push(...res.value);
          info.sentTo = res.rung.id;
          break;
        } catch (err) {
          const tried = attemptsOf(err);
          attempts.push(...tried);
          lastError = err;
          if (ctx.signal?.aborted) throw err;
          if (attempt >= MAX_RETRIES_PER_FRAME || maxWaitMs === 0 || !onlyRateLimited(tried)) {
            ctx.log.warn('no visual rung could read a frame', { atSec: d.atSec, error: err instanceof Error ? err.message : String(err) });
            break;
          }
          const known = rankRungs(rungs, chain, ctx.env)
            .map((r) => throttleRemainingMs(r.id))
            .filter((ms) => ms > 0);
          const waitMs = Math.min(maxWaitMs, (known.length > 0 ? Math.min(...known) : UNKNOWN_COOLDOWN_MS) + 250);
          ctx.log.info('every visual rung is rate-limited; waiting for the next slot', { atSec: d.atSec, waitSec: Math.ceil(waitMs / 1000) });
          await sleep(waitMs, ctx.signal);
        }
      }
      frames.push(info);
      ctx.log.debug('visual frame read', { frame: i + 1, of: chosen.length, atSec: d.atSec, rung: info.sentTo });
    }

    if (chosen.length > 0 && frames.every((f) => !f.sentTo)) {
      throw Object.assign(
        new Vid2ContextError('all-rungs-failed', `No visual rung could read any of the ${chosen.length} frames.`, {
          hint: 'See `attempts` for each failure. Local OCR (tesseract) needs no key or network after install.',
          cause: lastError,
        }),
        { attempts },
      );
    }
    return { notes: mergeNotes(notes), frames, attempts, durationSec: sampled.durationSec };
  } finally {
    await terminateTesseract();
    await rm(tmp, { recursive: true, force: true });
  }
}
