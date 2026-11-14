/**
 * Long-audio orchestrator. Splits audio that is too large (or too long) for
 * one speech-to-text request into chunks, transcribes them in parallel across
 * the ranked rungs, checkpoints each finished chunk, and stitches the results
 * into one Transcript with global timestamps.
 *
 *   plan     rank the enabled STT rungs; chunk byte limit = smallest maxBytes
 *            of the rungs that start chunks, minus 5 percent; about 10 minutes
 *   split    first splitter that can handle the container (caller's first,
 *            then the built-in mp3-frames and wav-pcm)
 *   run      `concurrency` workers; chunk i starts at rung i mod k and falls
 *            back along the rest of the ranked list, so one rung's rate limit
 *            does not stall the job. When every rung is cooling down the chunk
 *            waits and retries instead of failing.
 *   resume   each finished chunk is saved under
 *            longform:<refId>:<audioSha256>:<chunkIndex> for 7 days
 *   stitch   see stitch.ts
 */
import type { AudioBytes, AudioChunk, AudioSplitter } from '../audio-split.ts';
import { attemptsOf, rankRungs, runChain } from '../chain.ts';
import { fetchWithTimeout } from '../context.ts';
import { errorFromResponse, Vid2ContextError } from '../errors.ts';
import type { ChainOptions, SttOptions, SttResult, SttRung } from '../provider.ts';
import type { Registry } from '../registry.ts';
import type { Storage } from '../storage.ts';
import { hasKv, type KvStore, MemoryKv } from '../storage-ext.ts';
import type { Attempt, AudioInput, Ctx, Segment, Transcript, VideoRef } from '../types.ts';
import { mp3FramesSplitter } from './mp3.ts';
import { type SeamReport, stitchChunks } from './stitch.ts';
import { wavPcmSplitter } from './wav.ts';

/** Built-in, runtime-neutral splitters. */
export const builtinSplitters: AudioSplitter[] = [mp3FramesSplitter, wavPcmSplitter];

export interface LongformProgress {
  done: number;
  total?: number;
  message?: string;
}

export interface LongformOptions {
  stt?: SttOptions;
  chain?: ChainOptions;
  /** Extra splitters (an ffmpeg splitter for m4a/opus/webm). Tried before the built-in ones. */
  splitters?: AudioSplitter[];
  /** Chunks transcribed at once. Default 3. */
  concurrency?: number;
  /** Preferred chunk length in seconds. Default 600. */
  targetSec?: number;
  /** Overlap between chunks in seconds. Default 2. */
  overlapSec?: number;
  /** Cap the chunk size below what the rungs accept (bytes). */
  maxChunkBytes?: number;
  /** Checkpoint store. Default: `storage` when it implements KvStore, else a process-local MemoryKv. */
  kv?: KvStore;
  storage?: Storage | null;
  onProgress?(p: LongformProgress): void;
  /** Longest audio in seconds every rung accepts, when already known (for example from a 413 message). */
  maxPieceSec?: number;
  /** How long one chunk may wait in total for rate-limited rungs to cool down. Default 10 minutes. */
  rateLimitWaitMs?: number;
}

export interface LongformResult {
  transcript: Transcript;
  attempts: Attempt[];
  chunks: number;
  seams: SeamReport[];
}

interface Piece {
  producer: string;
  model: string;
  language: string;
  segments: Segment[];
}

interface Checkpoint extends Piece {
  startSec: number;
  durationSec: number;
}

/**
 * Optional, duck-typed: a rung may declare the longest audio it accepts in
 * seconds (OVH keyless allows 60). The planner keeps chunks under it.
 */
export interface SttDurationLimit {
  maxDurationSec?: number;
}

function maxDurationOf(r: SttRung): number | undefined {
  const d = (r as SttRung & SttDurationLimit).maxDurationSec;
  return typeof d === 'number' && d > 0 ? d : undefined;
}

/** Every rung tried refused the audio as too large (413 or a declared limit); nothing else went wrong. */
export function everyRungTooLarge(attempts: Attempt[]): boolean {
  const errors = attempts.filter((a) => a.outcome === 'error');
  return errors.length > 0 && errors.every((a) => a.reason?.startsWith('too-large'));
}

/** A duration limit stated in an upstream message, e.g. "max duration allowed ... is 60 seconds". */
export function durationLimitFrom(attempts: Attempt[]): number | undefined {
  for (const a of attempts) {
    const m = /duration[^0-9]{0,120}?(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds)\b/i.exec(a.detail ?? '');
    if (m) return Number(m[1]);
  }
  return undefined;
}

const MAX_DEPTH = 4;

const MB = 1024 * 1024;
const CHECKPOINT_TTL_SEC = 7 * 24 * 3600;
const RETRY_STEP_MS = 10_000;

function maxAudioBytes(ctx: Ctx): number {
  const mb = Number(ctx.env.VID2CONTEXT_MAX_AUDIO_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 1024) * MB;
}

/** Download a URL input into bytes, refusing anything over VID2CONTEXT_MAX_AUDIO_MB. */
export async function fetchAudioBytes(audio: AudioInput, ctx: Ctx): Promise<AudioBytes> {
  if (audio.kind === 'bytes') return audio;
  const cap = maxAudioBytes(ctx);
  const tooBig = (n: number) =>
    new Vid2ContextError('too-large', `Audio at ${audio.url} is ${n} bytes, over the ${cap}-byte limit.`, {
      hint: 'Raise VID2CONTEXT_MAX_AUDIO_MB, or pass a smaller (mono, low-bitrate) audio file.',
    });
  const res = await fetchWithTimeout(ctx, audio.url, {}, 30 * 60_000);
  if (!res.ok) throw await errorFromResponse(res, 'long-audio download');
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw tooBig(declared);
  const parts: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel();
        throw tooBig(size);
      }
      parts.push(value);
    }
  }
  const data = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.byteLength;
  }
  const name = new URL(audio.url).pathname.split('/').pop() || 'audio';
  return {
    kind: 'bytes',
    data,
    mimeType: audio.mimeType ?? res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
    filename: decodeURIComponent(name),
    durationSec: audio.durationSec,
  };
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when the audio is bytes and larger than every rung the chain would use accepts. */
export function exceedsEveryRung(registry: Registry, audio: AudioInput, chain: ChainOptions | undefined, ctx: Ctx): boolean {
  if (audio.kind !== 'bytes') return false;
  const ranked = rankRungs(registry.sttRungs(ctx.env), chain ?? {}, ctx.env);
  return ranked.length > 0 && ranked.every((r) => r.maxBytes !== undefined && audio.data.byteLength > r.maxBytes);
}

function tooLargeError(audio: AudioInput, detail: string): Vid2ContextError {
  const what = audio.kind === 'bytes' ? `${audio.filename} (${audio.mimeType})` : audio.url;
  return new Vid2ContextError(
    'too-large',
    `${what} is too large for every speech-to-text rung and no splitter handles it: ${detail}.`,
    {
      hint: 'Install the yt-dlp and ffmpeg providers so audio arrives as small mono MP3, or pass an ffmpeg splitter in `splitters`.',
    },
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Every failure was a rate limit or a cooldown skip: waiting will help. */
function onlyRateLimited(attempts: Attempt[]): boolean {
  return (
    attempts.length > 0 &&
    attempts.every(
      (a) =>
        (a.outcome === 'skipped' && a.reason === 'cooldown') || (a.outcome === 'error' && a.reason?.startsWith('rate-limited')),
    )
  );
}

/** A seam as an attempt; `tag` names the chunk for seams between the pieces of a re-split chunk (times are chunk-local there). */
function seamAttempt(s: SeamReport, parts: number, tag?: string): Attempt {
  const where = `seam ${s.index}/${parts - 1} at ${s.cutSec.toFixed(2)}s`;
  const matched = s.method === 'aligned' ? `, ${s.matchedWords} words matched` : '';
  return {
    id: 'longform/stitch',
    stage: 'stt',
    outcome: 'ok',
    reason: s.method,
    detail: `${tag ? `${tag} ` : ''}${where}${matched}`,
  };
}

function majority(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? '';
  for (const [v, n] of counts) if (n > (counts.get(best) ?? 0)) best = v;
  return best;
}

/** Transcribe audio of any length into one Transcript. */
export async function transcribeLong(
  registry: Registry,
  ref: VideoRef,
  input: AudioInput,
  opts: LongformOptions,
  ctx: Ctx,
): Promise<LongformResult> {
  const chain = opts.chain ?? {};
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const attempts: Attempt[] = [];

  // Plan.
  const ranked = rankRungs(registry.sttRungs(ctx.env), chain, ctx.env);
  if (ranked.length === 0) {
    throw Object.assign(
      new Vid2ContextError('no-provider', 'No stt rung is enabled.', {
        hint: 'Configure a speech-to-text provider (see docs/providers.md). Keyless lanes need VID2CONTEXT_KEYLESS unset.',
      }),
      { attempts },
    );
  }
  const starters = ranked.slice(0, Math.min(concurrency, ranked.length));
  const limits = starters.map((r) => r.maxBytes).filter((b): b is number => b !== undefined);
  let maxBytes = limits.length > 0 ? Math.floor(Math.min(...limits) * 0.95) : Number.MAX_SAFE_INTEGER;
  if (opts.maxChunkBytes) maxBytes = Math.min(maxBytes, opts.maxChunkBytes);
  const durations = starters.map(maxDurationOf).filter((d): d is number => d !== undefined);
  if (opts.maxPieceSec && opts.maxPieceSec > 0) durations.push(opts.maxPieceSec);
  let learnedMaxSec: number | undefined = durations.length > 0 ? Math.min(...durations) * 0.95 : undefined;
  const targetSec = Math.min(opts.targetSec ?? 600, learnedMaxSec ?? Number.POSITIVE_INFINITY);
  const overlapSec = opts.overlapSec ?? 2;

  const splitters = [...(opts.splitters ?? []), ...builtinSplitters];
  if (input.kind === 'url' && !splitters.some((s) => s.canSplit(input))) {
    throw Object.assign(tooLargeError(input, 'unrecognised container'), {
      attempts: [
        {
          id: 'longform',
          stage: 'stt',
          outcome: 'error',
          reason: 'too-large',
          detail: 'no splitter for this container',
        } as Attempt,
      ],
    });
  }
  const audio = await fetchAudioBytes(input, ctx);
  const splitter = splitters.find((s) => s.canSplit(audio));
  if (!splitter) {
    throw Object.assign(tooLargeError(audio, 'no splitter for this container'), {
      attempts: [
        {
          id: 'longform',
          stage: 'stt',
          outcome: 'error',
          reason: 'too-large',
          detail: `no splitter for ${audio.mimeType}`,
        } as Attempt,
      ],
    });
  }

  // Split.
  const splitStarted = Date.now();
  const chunks: AudioChunk[] = [];
  for await (const c of splitter.split(audio, { maxBytes, targetSec, overlapSec }, ctx)) {
    chunks.push(c);
  }
  const total = chunks.length;
  attempts.push({
    id: splitter.id,
    stage: 'stt',
    outcome: 'ok',
    reason: 'split',
    detail: `${total} chunks of at most ${maxBytes === Number.MAX_SAFE_INTEGER ? 'any size' : `${maxBytes} bytes`}`,
    ms: Date.now() - splitStarted,
  });
  ctx.log.info('long audio split', { splitter: splitter.id, chunks: total, bytes: audio.data.byteLength });
  opts.onProgress?.({ done: 0, total, message: `split into ${total} chunks` });

  // Resume state.
  const kv: KvStore = opts.kv ?? (hasKv(opts.storage) ? opts.storage : new MemoryKv());
  const sha = await sha256Hex(audio.data);
  const keyOf = (i: number) => `longform:${ref.id}:${sha}:${i}`;

  const results: (Checkpoint | undefined)[] = new Array(total);
  const chunkAttempts: Attempt[][] = chunks.map(() => []);
  const waitBudget = opts.rateLimitWaitMs ?? 10 * 60_000;
  let done = 0;

  const label = (i: number, detail?: string) => `chunk ${i + 1}/${total}${detail ? `: ${detail}` : ''}`;
  const tagged = (tag: string, a: Attempt): Attempt => ({ ...a, detail: a.detail ? `${tag}: ${a.detail}` : tag });

  /** One request per rung order, waiting out rate limits. Throws with the last round's attempts attached. */
  async function chainWithWait(
    piece: AudioBytes,
    durationSec: number,
    seed: number,
    tag: string,
    log: Attempt[],
  ): Promise<Piece> {
    const size = piece.data.byteLength;
    const fits = ranked.filter(
      (r) =>
        (r.maxBytes === undefined || size <= r.maxBytes) &&
        (maxDurationOf(r) === undefined || durationSec <= (maxDurationOf(r) as number)),
    );
    for (const r of ranked) {
      if (!fits.includes(r)) log.push({ id: r.id, stage: 'stt', outcome: 'skipped', reason: 'too-large', detail: tag });
    }
    // Start at a different rung per chunk (round-robin over the starters), then fall back along the rest in rank order.
    const first = starters[seed % starters.length] as SttRung;
    const order = fits.includes(first) ? [first, ...fits.filter((r) => r !== first)] : fits;
    const call = (rung: SttRung) => rung.transcribe(piece, opts.stt ?? {}, ctx);
    let waited = 0;
    for (;;) {
      const round: Attempt[] = [];
      try {
        let res: { value: SttResult; rung: SttRung; attempts: Attempt[] } | undefined;
        const head = order[0];
        if (head) {
          try {
            res = await runChain<SttRung, SttResult>('stt', [head], call, chain, ctx);
          } catch (err) {
            if (ctx.signal?.aborted || order.length === 1) throw err;
            round.push(...attemptsOf(err));
          }
        }
        if (!res) {
          const max = Math.max(1, (chain.maxAttempts ?? 8) - 1);
          res = await runChain<SttRung, SttResult>('stt', order.slice(1), call, { ...chain, maxAttempts: max }, ctx);
        }
        round.push(...res.attempts);
        log.push(...round.map((a) => tagged(tag, a)));
        return { producer: res.rung.id, model: res.value.model, language: res.value.language, segments: res.value.segments };
      } catch (err) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? err;
        const all = [...round, ...attemptsOf(err)];
        log.push(...all.map((a) => tagged(tag, a)));
        if (!onlyRateLimited(all) || waited >= waitBudget) throw Object.assign(err as object, { attempts: all });
        const step = Math.min(RETRY_STEP_MS, waitBudget - waited);
        ctx.log.info('every stt rung is rate limited, waiting', { piece: tag, waitMs: step });
        await sleep(step, ctx.signal);
        waited += step;
      }
    }
  }

  /**
   * Transcribe one piece. When every rung refuses it as too large (a duration
   * cap such as OVH keyless's 60 seconds), learn the limit, split the piece
   * again and stitch the parts.
   */
  async function transcribePiece(
    piece: AudioBytes,
    durationSec: number,
    seed: number,
    tag: string,
    log: Attempt[],
    depth: number,
  ): Promise<Piece> {
    if (learnedMaxSec !== undefined && durationSec > learnedMaxSec && depth < MAX_DEPTH) {
      return resplit(piece, seed, tag, log, depth);
    }
    try {
      return await chainWithWait(piece, durationSec, seed, tag, log);
    } catch (err) {
      const round = attemptsOf(err);
      if (depth >= MAX_DEPTH || !everyRungTooLarge(round)) throw err;
      const said = durationLimitFrom(round);
      // Use the stated limit when there is one that this piece breaks; otherwise halve.
      let limit = said !== undefined ? said * 0.95 : durationSec / 2;
      if (limit >= durationSec) limit = durationSec / 2;
      learnedMaxSec = Math.min(learnedMaxSec ?? Number.POSITIVE_INFINITY, limit);
      log.push({
        id: 'longform',
        stage: 'stt',
        outcome: 'ok',
        reason: 'resplit',
        detail: `${tag}: every rung refused ${durationSec.toFixed(1)}s as too large; splitting to ${learnedMaxSec.toFixed(1)}s pieces`,
      });
      ctx.log.info('stt rungs refused a chunk as too large, splitting it further', { piece: tag, maxSec: learnedMaxSec });
      return resplit(piece, seed, tag, log, depth);
    }
  }

  async function resplit(piece: AudioBytes, seed: number, tag: string, log: Attempt[], depth: number): Promise<Piece> {
    const sub = splitters.find((s) => s.canSplit(piece));
    if (!sub) throw tooLargeError(piece, 'no splitter for a chunk');
    const parts: AudioChunk[] = [];
    for await (const p of sub.split(piece, { maxBytes, targetSec: learnedMaxSec, overlapSec }, ctx)) parts.push(p);
    const pieces: Piece[] = [];
    for (const p of parts) {
      pieces.push(
        await transcribePiece(
          p.audio,
          p.durationSec,
          seed + p.index,
          `${tag} part ${p.index + 1}/${parts.length}`,
          log,
          depth + 1,
        ),
      );
    }
    const { segments, seams } = stitchChunks(parts.map((p, k) => ({ ...p, segments: (pieces[k] as Piece).segments })));
    for (const s of seams) log.push(seamAttempt(s, parts.length, tag));
    const producer = majority(pieces.map((p) => p.producer));
    return {
      producer,
      model: majority(pieces.filter((p) => p.producer === producer).map((p) => p.model)),
      language: majority(pieces.map((p) => p.language)),
      segments,
    };
  }

  async function runOne(i: number): Promise<void> {
    const chunk = chunks[i] as AudioChunk;
    const log = chunkAttempts[i] as Attempt[];
    const saved = await kv.kvGet<Checkpoint>(keyOf(i));
    if (saved && Math.abs(saved.startSec - chunk.startSec) < 1e-3 && Math.abs(saved.durationSec - chunk.durationSec) < 1e-3) {
      results[i] = saved;
      log.push({ id: saved.producer, stage: 'stt', outcome: 'ok', reason: 'resumed', detail: label(i) });
      return;
    }
    const piece = await transcribePiece(chunk.audio, chunk.durationSec, i, label(i), log, 0);
    const cp: Checkpoint = { startSec: chunk.startSec, durationSec: chunk.durationSec, ...piece };
    results[i] = cp;
    await kv.kvSet(keyOf(i), cp, { ttlSec: CHECKPOINT_TTL_SEC });
  }

  // Run with bounded concurrency.
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && !ctx.signal?.aborted && next < total) {
      const i = next++;
      try {
        await runOne(i);
        done++;
        const r = results[i] as Checkpoint;
        opts.onProgress?.({ done, total, message: `${label(i)} via ${r.producer}` });
      } catch (err) {
        if (failure === undefined) failure = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  for (const log of chunkAttempts) attempts.push(...log);
  if (ctx.signal?.aborted) {
    throw Object.assign(
      ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error(String(ctx.signal.reason ?? 'aborted')),
      {
        attempts,
      },
    );
  }
  if (failure !== undefined) throw Object.assign(failure as object, { attempts });

  // Stitch.
  const finished = results as Checkpoint[];
  const { segments, seams } = stitchChunks(
    chunks.map((c, i) => ({
      startSec: c.startSec,
      durationSec: c.durationSec,
      overlapSec: c.overlapSec,
      segments: (finished[i] as Checkpoint).segments,
    })),
  );
  for (const s of seams) attempts.push(seamAttempt(s, total));
  for (const a of attempts) {
    if (a.id === 'longform/stitch' && a.reason === 'time-cut')
      ctx.log.warn('long audio seam not aligned, cut by time', { seam: a.detail });
  }
  const producer = majority(finished.map((r) => r.producer));
  const transcript: Transcript = {
    ref,
    language: majority(finished.map((r) => r.language)),
    origin: 'stt',
    producer,
    model: majority(finished.filter((r) => r.producer === producer).map((r) => r.model)),
    segments,
    createdAt: new Date().toISOString(),
  };
  return { transcript, attempts, chunks: total, seams };
}
