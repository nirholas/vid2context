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
 *   resplit  a chunk every rung refuses as too large (413: OVH keyless caps
 *            audio at 60 s) is split again under the limit the error states
 *            (or half its length), and the limit applies to later chunks too
 *   loops    a piece whose text holds a decoder loop (Whisper repeating one
 *            phrase over and over, which drops the real speech under it) is
 *            sent again: first to the other rungs, then split in two at
 *            different cut points. Only when every retry still loops is the
 *            loop cut back by the repetition guard, and the attempts say so.
 *   resume   each finished chunk is saved under
 *            longform:<refId>:<audioSha256>:<chunkIndex> for 7 days
 *   stitch   see stitch.ts; the stitched transcript then goes through the
 *            repetition guard once more, for loops that run across a seam
 */
import type { AudioBytes, AudioChunk, AudioSplitter } from '../audio-split.ts';
import { attemptsOf, cooldownReason, rankRungs, runChain } from '../chain.ts';
import { guardRepetition } from '../clean/repetition.ts';
import { fetchWithTimeout } from '../context.ts';
import { errorFromResponse, Vid2ContextError } from '../errors.ts';
import type { ChainOptions, SttOptions, SttResult, SttRung } from '../provider.ts';
import type { Registry } from '../registry.ts';
import { limits } from '../security/limits.ts';
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
  /**
   * Split a piece whose answer loops into two and send the halves (default true). Each piece is split for a loop
   * at most once, so a stubborn loop costs a few requests, not a cascade. False when the whole call is already a
   * retry of a looped answer (the single-request path does that), so its chunks only try the other rungs.
   */
  splitLoops?: boolean;
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
 * The longest audio a rung accepts in seconds (OVH keyless allows 60). Now a
 * field of SttRung; this type is kept so code written against it still compiles.
 */
export interface SttDurationLimit {
  maxDurationSec?: number;
}

function maxDurationOf(r: SttRung): number | undefined {
  const d = r.maxDurationSec;
  return typeof d === 'number' && d > 0 ? d : undefined;
}

/** Pieces shorter than this are not split again to escape a decoder loop. */
export const MIN_LOOP_SPLIT_SEC = 8;

/**
 * True when the segments hold a decoder loop: a phrase repeated so many times
 * in a row that the repetition guard would cut text out. Natural repeats
 * ("yes yes", "really really well") and a flagged sign-off line do not count.
 */
export function hasDecoderLoop(segments: readonly Segment[]): boolean {
  const { report } = guardRepetition(segments, { flagHallucinations: false });
  return report.rewritten + report.removed > 0;
}

/**
 * Chunk length for re-transcribing a looped piece: exactly two parts that
 * overlap by `overlapSec`, so the decoder hears each half without the context
 * that sent it into the loop. (The planner steps by target minus overlap, so a
 * target of half the length would give three or four parts.)
 */
export function loopRetryTargetSec(durationSec: number, overlapSec = 2): number {
  return durationSec / 2 + overlapSec + 0.5;
}

/**
 * Run the repetition guard on finished segments. Returns the cleaned segments
 * and, when it changed or flagged anything, the attempt that records it.
 */
export function guardSegments(segments: readonly Segment[]): { segments: Segment[]; attempt?: Attempt } {
  const guard = guardRepetition(segments);
  const collapsed = guard.report.rewritten + guard.report.removed;
  if (collapsed + guard.report.flagged === 0) return { segments: [...segments] };
  const flagged = guard.report.flagged ? `, flagged ${guard.report.flagged}` : '';
  return {
    segments: guard.segments,
    attempt: { id: 'clean/repetition-guard', stage: 'stt', outcome: 'ok', detail: `collapsed ${collapsed} segments${flagged}` },
  };
}

/**
 * Splitting the audio would help: at least one rung refused it as too large
 * (413 or a declared limit), and every other failure was an auth error. A
 * rung with a bad or missing key fails on any piece size and the chain puts it
 * on cooldown, so it must not stop the rungs that would take smaller pieces.
 */
export function everyRungTooLarge(attempts: Attempt[]): boolean {
  // A rung skipped up front for a declared limit (`skipped`, `too-large`) refused the audio as surely as a 413 would.
  const refusals = attempts.filter(
    (a) => (a.outcome === 'error' && !a.reason?.startsWith('auth')) || (a.outcome === 'skipped' && a.reason === 'too-large'),
  );
  return refusals.length > 0 && refusals.every((a) => a.reason?.startsWith('too-large'));
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

const CHECKPOINT_TTL_SEC = 7 * 24 * 3600;
const RETRY_STEP_MS = 10_000;

function maxAudioBytes(ctx: Ctx): number {
  return limits(ctx.env, ctx.runtime).maxAudioBytes;
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

/** True when the rung declares an upload or duration limit this audio breaks. */
export function audioExceedsRung(r: SttRung, audio: AudioBytes): boolean {
  if (r.maxBytes !== undefined && audio.data.byteLength > r.maxBytes) return true;
  const maxSec = maxDurationOf(r);
  return maxSec !== undefined && audio.durationSec !== undefined && audio.durationSec > maxSec;
}

/** True when the audio is bytes and larger (in bytes, or in seconds when its length is known) than every rung the chain would use accepts. */
export function exceedsEveryRung(registry: Registry, audio: AudioInput, chain: ChainOptions | undefined, ctx: Ctx): boolean {
  if (audio.kind !== 'bytes') return false;
  const ranked = rankRungs(registry.sttRungs(ctx.env), chain ?? {}, ctx.env);
  return ranked.length > 0 && ranked.every((r) => audioExceedsRung(r, audio));
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

function isCooldownSkip(a: Attempt): boolean {
  return a.outcome === 'skipped' && a.reason === 'cooldown';
}

/** Cooldowns that end on their own: waiting for these helps. A rejected key ('auth') or a missing model does not. */
const PASSING_COOLDOWNS = new Set(['rate-limited', 'upstream', 'timeout']);

/**
 * Whether waiting and asking again can help after a failed round. Yes when at least one rung will be back (it
 * answered with a rate limit, or is skipped for a cooldown that ends on its own) and nothing else failed in a way
 * waiting could fix or rule out: rungs that failed on auth, or are cooling down after one, are left out of the
 * decision (they stay out either way, and must not stop the wait for a rate-limited rung). `cooldownOf` returns why
 * a skipped rung is cooling down (`cooldownReason`), undefined when its cooldown is already over.
 */
export function waitHelps(attempts: Attempt[], cooldownOf: (rungId: string) => string | undefined): boolean {
  let comesBack = false;
  for (const a of attempts) {
    if (a.outcome === 'error') {
      if (a.reason?.startsWith('rate-limited')) comesBack = true;
      else if (!a.reason?.startsWith('auth')) return false;
    } else if (isCooldownSkip(a)) {
      const why = cooldownOf(a.id);
      if (why === undefined || PASSING_COOLDOWNS.has(why)) comesBack = true;
    }
  }
  return comesBack;
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

  // The caller's splitters, then the built-in MP3 and WAV ones, then the runtime's (ffmpeg on Node) for every other container.
  const splitters = [...(opts.splitters ?? []), ...builtinSplitters, ...registry.splitters];
  // A URL that names its container (mime type or extension) and that no splitter claims fails before the download.
  const named = input.kind === 'url' && (Boolean(input.mimeType) || /\.[a-z0-9]{2,5}$/i.test(new URL(input.url).pathname));
  if (input.kind === 'url' && named && !splitters.some((s) => s.canSplit(input))) {
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

  const waitWillHelp = (list: Attempt[]): boolean =>
    waitHelps(list, (id) => {
      const rung = ranked.find((r) => r.id === id);
      return rung ? cooldownReason(rung, ctx.env) : undefined;
    });

  const label = (i: number, detail?: string) => `chunk ${i + 1}/${total}${detail ? `: ${detail}` : ''}`;
  const tagged = (tag: string, a: Attempt): Attempt => ({ ...a, detail: a.detail ? `${tag}: ${a.detail}` : tag });

  /**
   * One request per rung order, waiting out rate limits. Throws with the last round's attempts attached.
   * Rungs named in `exclude` are not asked (a rung whose answer for this piece looped).
   *
   * While every rung is rate limited the per-round cooldown skips are not logged one by one: the 429s are kept,
   * and one `rate-limit-wait` attempt says how long the piece waited in total.
   */
  async function chainWithWait(
    piece: AudioBytes,
    durationSec: number,
    seed: number,
    tag: string,
    log: Attempt[],
    exclude: readonly string[] = [],
  ): Promise<Piece> {
    const size = piece.data.byteLength;
    const fits = ranked.filter(
      (r) =>
        !exclude.includes(r.id) &&
        (r.maxBytes === undefined || size <= r.maxBytes) &&
        (maxDurationOf(r) === undefined || durationSec <= (maxDurationOf(r) as number)),
    );
    for (const r of ranked) {
      if (exclude.includes(r.id)) continue;
      if (!fits.includes(r)) log.push({ id: r.id, stage: 'stt', outcome: 'skipped', reason: 'too-large', detail: tag });
    }
    if (fits.length === 0) {
      throw Object.assign(
        new Vid2ContextError('no-provider', `No speech-to-text rung is left to try for ${tag}.`, {
          hint: 'Configure another speech-to-text provider (see docs/providers.md).',
        }),
        { attempts: [] as Attempt[] },
      );
    }
    const waitNote = (waited: number) => {
      if (waited > 0) {
        log.push({
          id: 'longform',
          stage: 'stt',
          outcome: 'ok',
          reason: 'rate-limit-wait',
          detail: `${tag}: waited ${Math.round(waited / 1000)}s for rate limits`,
        });
      }
    };
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
        log.push(...round.filter((a) => !(waited > 0 && isCooldownSkip(a))).map((a) => tagged(tag, a)));
        waitNote(waited);
        return { producer: res.rung.id, model: res.value.model, language: res.value.language, segments: res.value.segments };
      } catch (err) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? err;
        const all = [...round, ...attemptsOf(err)];
        const willWait = waitWillHelp(all) && waited < waitBudget;
        log.push(...all.filter((a) => !(willWait && isCooldownSkip(a))).map((a) => tagged(tag, a)));
        if (!willWait) {
          waitNote(waited);
          throw Object.assign(err as object, { attempts: all });
        }
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
    loopSplit: boolean,
  ): Promise<Piece> {
    if (learnedMaxSec !== undefined && durationSec > learnedMaxSec && depth < MAX_DEPTH) {
      return resplit(piece, seed, tag, log, depth, loopSplit);
    }
    try {
      const first = await chainWithWait(piece, durationSec, seed, tag, log);
      if (!hasDecoderLoop(first.segments)) return first;
      return await escapeLoop(first, piece, durationSec, seed, tag, log, depth, loopSplit);
    } catch (err) {
      const round = attemptsOf(err);
      if (ctx.signal?.aborted || depth >= MAX_DEPTH) throw err;
      // The rungs that would take this piece all failed in ways a smaller piece cannot fix (a rejected key, a
      // cooldown), while a rung that declares a shorter cap than this piece was never asked: split for that rung.
      // (Chunks are planned for the first-ranked rungs; when those have bad keys, the plan is too coarse.)
      const capped = ranked
        .map(maxDurationOf)
        .filter(
          (d): d is number => d !== undefined && d < durationSec && (learnedMaxSec === undefined || d * 0.95 < learnedMaxSec),
        );
      const noFixHere = round.every(
        (a) => a.outcome === 'skipped' || (a.outcome === 'error' && Boolean(a.reason?.startsWith('auth'))),
      );
      if (capped.length > 0 && noFixHere) {
        learnedMaxSec = Math.min(...capped) * 0.95;
        log.push({
          id: 'longform',
          stage: 'stt',
          outcome: 'ok',
          reason: 'resplit',
          detail: `${tag}: the rungs that take ${durationSec.toFixed(1)}s failed, and the rest take at most ${Math.min(...capped)}s; splitting to ${learnedMaxSec.toFixed(1)}s pieces`,
        });
        ctx.log.info('only length-capped stt rungs are left, splitting the chunk further', { piece: tag, maxSec: learnedMaxSec });
        return resplit(piece, seed, tag, log, depth, loopSplit);
      }
      if (!everyRungTooLarge(round)) throw err;
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
      return resplit(piece, seed, tag, log, depth, loopSplit);
    }
  }

  /**
   * A piece came back with a decoder loop. Whisper loops are tied to the exact
   * audio it was given, so the same piece is asked of the other rungs first,
   * then (when `loopSplit`) split in two at new cut points; the halves are
   * checked the same way but never split again for a loop. When nothing
   * escapes the loop, the first answer is kept with the loop cut back by the
   * repetition guard.
   */
  async function escapeLoop(
    first: Piece,
    piece: AudioBytes,
    durationSec: number,
    seed: number,
    tag: string,
    log: Attempt[],
    depth: number,
    loopSplit: boolean,
  ): Promise<Piece> {
    const tried = [first.producer];
    const noteLoop = (p: Piece) =>
      log.push({
        id: p.producer,
        stage: 'stt',
        outcome: 'error',
        reason: 'repetition-loop',
        detail: `${tag}: the transcript repeats one phrase over and over (a decoder loop), so the speech under it was lost`,
      });
    noteLoop(first);
    ctx.log.warn('stt answer holds a decoder loop, retrying', { piece: tag, rung: first.producer });

    for (;;) {
      let alt: Piece;
      try {
        alt = await chainWithWait(piece, durationSec, seed + tried.length, tag, log, tried);
      } catch (err) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? err;
        break;
      }
      if (!hasDecoderLoop(alt.segments)) return alt;
      noteLoop(alt);
      tried.push(alt.producer);
    }

    if (loopSplit && depth < MAX_DEPTH && durationSec >= MIN_LOOP_SPLIT_SEC && splitters.some((s) => s.canSplit(piece))) {
      const target = loopRetryTargetSec(durationSec, overlapSec);
      log.push({
        id: 'longform',
        stage: 'stt',
        outcome: 'ok',
        reason: 'loop-resplit',
        detail: `${tag}: splitting ${durationSec.toFixed(1)}s into pieces of about ${target.toFixed(1)}s to escape the loop`,
      });
      try {
        return await resplit(piece, seed, tag, log, depth, false, target);
      } catch (err) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? err;
        log.push(...attemptsOf(err).map((a) => tagged(tag, a)));
      }
    }

    const kept = guardSegments(first.segments);
    log.push({
      id: 'clean/repetition-guard',
      stage: 'stt',
      outcome: 'ok',
      reason: 'loop-kept',
      detail: `${tag}: every retry still looped; the loop was cut back and the speech under it is missing`,
    });
    return { ...first, segments: kept.segments };
  }

  async function resplit(
    piece: AudioBytes,
    seed: number,
    tag: string,
    log: Attempt[],
    depth: number,
    loopSplit: boolean,
    targetSec: number | undefined = learnedMaxSec,
  ): Promise<Piece> {
    const sub = splitters.find((s) => s.canSplit(piece));
    if (!sub) throw tooLargeError(piece, 'no splitter for a chunk');
    const parts: AudioChunk[] = [];
    const pieceTarget = targetSec !== undefined && learnedMaxSec !== undefined ? Math.min(targetSec, learnedMaxSec) : targetSec;
    for await (const p of sub.split(piece, { maxBytes, targetSec: pieceTarget, overlapSec }, ctx)) parts.push(p);
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
          loopSplit,
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
    const piece = await transcribePiece(chunk.audio, chunk.durationSec, i, label(i), log, 0, opts.splitLoops !== false);
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
  const { segments: stitched, seams } = stitchChunks(
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
  // Same guard the single-request path runs: catches loops that run across a seam and sign-off lines invented on
  // silence at the end, and cleans checkpoints saved by versions that did not check pieces for loops.
  const guarded = guardSegments(stitched);
  const segments = guarded.segments;
  if (guarded.attempt) attempts.push(guarded.attempt);
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
