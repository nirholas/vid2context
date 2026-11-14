/**
 * Follow a live stream and transcribe it while it runs.
 *
 *   producer   polls the media playlist every target duration, downloads new
 *              segments in media-sequence order into a bounded buffer, and
 *              stops on EXT-X-ENDLIST, maxMinutes or cancellation
 *   consumer   (the async generator) cuts the buffer into chunkSec windows
 *              that repeat overlapSec of the previous window, extracts 16 kHz
 *              mono audio, runs the core speech-to-text chain, shifts times
 *              to stream time and drops words repeated in the overlap
 *
 * The two run concurrently, so a slow speech-to-text call never makes the
 * poller miss segments that slide out of a short live playlist (YouTube's
 * holds about 30 seconds). When transcription falls more than maxLagSec
 * behind the live edge, the buffer skips ahead and a status event says which
 * span was skipped, so memory stays bounded.
 */
import {
  type Attempt,
  attemptsOf,
  type Ctx,
  fetchWithTimeout,
  formatTimestamp,
  isInputError,
  rankRungs,
  type Segment,
  type Transcript,
  transcribe,
  Vid2ContextError,
} from '@vid2context/core';
import { type MediaPlaylist, type MediaSegment, parsePlaylist } from './hls.ts';
import { dedupeOverlap, wordsOf } from './overlap.ts';
import { type LiveSource, resolveLive } from './resolve.ts';
import type { ChunkMedia, LiveDeps, LiveEvent, LiveStatusCode, WatchLiveOptions } from './types.ts';
import { NOT_LIVE_HINT } from './youtube.ts';

export const LIVE_DEFAULTS = { chunkSec: 30, overlapSec: 2, maxLagSec: 120, catchUpChunks: 3 } as const;

/** Consecutive playlist failures before giving up on a stream. */
const MAX_PLAYLIST_FAILURES = 6;
/** Retries for one media segment before counting it as missed. */
const SEGMENT_RETRIES = 2;
/** A chunk shorter than this at the end of a stream is not worth a request. */
const MIN_TAIL_SEC = 1;
/** Words of already emitted text kept for overlap matching. */
const TAIL_WORDS = 24;

type DoneReason = Extract<LiveEvent, { type: 'done' }>['reason'];

interface Buffered {
  sequence: number;
  /** Stream time. */
  startSec: number;
  duration: number;
  data: Uint8Array;
  initUri?: string;
  programDateMs?: number;
}

const endOf = (b: Buffered) => b.startSec + b.duration;

/** Where to start reading a playlist: `fromSequence` when given and still listed, else the newest `chunkSec` of audio. */
export function chooseStartSequence(
  playlist: MediaPlaylist,
  opts: { fromSequence?: number; chunkSec: number },
): { start: number; gap?: { from: number; to: number } } {
  const first = playlist.segments[0]?.sequence ?? playlist.mediaSequence;
  if (opts.fromSequence !== undefined) {
    if (opts.fromSequence < first) return { start: first, gap: { from: opts.fromSequence, to: first - 1 } };
    return { start: opts.fromSequence };
  }
  let covered = 0;
  let start = first;
  for (let i = playlist.segments.length - 1; i >= 0 && covered < opts.chunkSec; i--) {
    const seg = playlist.segments[i] as MediaSegment;
    start = seg.sequence;
    covered += seg.duration;
  }
  return { start };
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

/** setTimeout as a promise that the signal cancels. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wakes waiters whenever the shared state changes. */
class Pulse {
  private waiters: (() => void)[] = [];
  notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.push(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

const span = (a: number, b: number) => `${formatTimestamp(a)} to ${formatTimestamp(b)}`;

/** "stt/groq/x cooling down, stt/ovh/y rate-limited-429" for every rung that did not succeed. */
export function describeAttempts(attempts: Attempt[]): string {
  return attempts
    .filter((a) => a.outcome !== 'ok')
    .map((a) => `${a.id} ${a.reason === 'cooldown' ? 'cooling down' : (a.reason ?? a.outcome)}`)
    .join(', ');
}

function validate(opts: WatchLiveOptions): { chunkSec: number; overlapSec: number; maxLagSec: number; catchUpChunks: number } {
  const chunkSec = opts.chunkSec ?? LIVE_DEFAULTS.chunkSec;
  const overlapSec = opts.overlapSec ?? LIVE_DEFAULTS.overlapSec;
  const maxLagSec = opts.maxLagSec ?? LIVE_DEFAULTS.maxLagSec;
  const bad = (msg: string, hint: string) => new Vid2ContextError('bad-request', msg, { hint });
  if (!(chunkSec >= 2 && chunkSec <= 600))
    throw bad(`chunkSec ${chunkSec} is out of range.`, 'Use 2 to 600 seconds (default 30).');
  if (!(overlapSec >= 0 && overlapSec < chunkSec / 2)) {
    throw bad(`overlapSec ${overlapSec} is out of range.`, 'Use 0 up to half of chunkSec (default 2).');
  }
  if (!(maxLagSec >= chunkSec)) throw bad(`maxLagSec ${maxLagSec} is below chunkSec.`, 'Use at least chunkSec (default 120).');
  if (opts.maxMinutes !== undefined && !(opts.maxMinutes > 0)) {
    throw bad(`maxMinutes ${opts.maxMinutes} is not positive.`, 'Omit it to watch until the stream ends.');
  }
  if (opts.fromSequence !== undefined && !(Number.isInteger(opts.fromSequence) && opts.fromSequence >= 0)) {
    throw bad(`fromSequence ${opts.fromSequence} is not a media sequence number.`, 'Pass the resumeSequence of the last event.');
  }
  const catchUpChunks = opts.catchUpChunks ?? LIVE_DEFAULTS.catchUpChunks;
  if (!(Number.isInteger(catchUpChunks) && catchUpChunks >= 1 && catchUpChunks <= 10)) {
    throw bad(
      `catchUpChunks ${catchUpChunks} is out of range.`,
      'Use a whole number from 1 (never merge chunks) to 10 (default 3).',
    );
  }
  return { chunkSec, overlapSec, maxLagSec, catchUpChunks };
}

/**
 * Transcribe a live stream while it runs. Yields `segment` events about every
 * `chunkSec` seconds, `status` events for anything worth telling the user
 * (the rung in use, cooldowns and fallbacks, skipped or missed spans), and
 * one final `done` event with the whole transcript when the stream ends,
 * `maxMinutes` pass or the signal aborts. Throws a Vid2ContextError before
 * the first segment when the input is not a live stream or nothing can
 * transcribe it.
 */
export async function* watchLive(input: string, opts: WatchLiveOptions, deps: LiveDeps): AsyncGenerator<LiveEvent> {
  const { chunkSec, overlapSec, maxLagSec, catchUpChunks } = validate(opts);
  const extractor = deps.extractAudio;
  if (!extractor) {
    throw new Vid2ContextError('no-provider', 'Live transcription needs an audio extractor (ffmpeg), which runs on Node only.', {
      hint: "Pass extractAudio: createFfmpegExtractor({ env: ctx.env }) from '@vid2context/live/node'.",
    });
  }
  const sleep = deps.sleep ?? abortableSleep;
  const { registry } = deps;
  const env = deps.ctx.env;
  const chain = opts.chain ?? {};

  const ranked = rankRungs(registry.sttRungs(env), chain, env);
  const topRung = ranked[0];
  if (!topRung) {
    throw new Vid2ContextError('no-provider', 'No speech-to-text rung is enabled, so a live stream cannot be transcribed.', {
      hint: 'Enable one: a local server (LOCAL_STT_BASE_URL), a free Groq key (GROQ_API_KEY), or leave VID2CONTEXT_KEYLESS unset.',
    });
  }

  // One controller stops everything: the caller's signal, the context's signal, or the generator closing.
  const stop = new AbortController();
  const outer = [opts.signal, deps.ctx.signal].filter((s): s is AbortSignal => Boolean(s));
  const onOuterAbort = () => stop.abort(new DOMException('Cancelled', 'AbortError'));
  for (const s of outer) {
    if (s.aborted) onOuterAbort();
    else s.addEventListener('abort', onOuterAbort, { once: true });
  }
  const ctx: Ctx = { ...deps.ctx, signal: stop.signal };

  const pulse = new Pulse();
  const statuses: LiveEvent[] = [];
  const pushStatus = (code: LiveStatusCode, message: string, resumeSequence?: number) => {
    statuses.push({ type: 'status', code, message, ...(resumeSequence !== undefined ? { resumeSequence } : {}) });
    pulse.notify();
  };

  // Shared between producer and consumer. JavaScript runs one of them at a time, so plain fields are enough.
  const buffer: Buffered[] = [];
  const inits = new Map<string, Uint8Array>();
  let source: LiveSource | null = null;
  let lastSeq: number | null = null;
  let lastEndSec = 0;
  let nominal = 1;
  let cursor: number | null = null; // next window start, stream time
  let inflightEnd: number | null = null; // end of the chunk being transcribed right now
  let overlapNext = false; // whether the next window repeats the end of the previous one
  let finished: Exclude<DoneReason, 'cancelled'> | null = null;
  let fatal: unknown = null;
  let running: Promise<void> | undefined;

  const segments: Segment[] = [];
  const producers = new Set<string>();
  const models = new Set<string>();
  let language: string | undefined;
  let reason: DoneReason = 'ended';

  const bufferEnd = (): number | null => {
    const last = buffer.at(-1);
    return last ? endOf(last) : null;
  };
  const resumeSequence = (): number | undefined => {
    const at = cursor;
    if (at === null) return buffer[0]?.sequence;
    return buffer.find((b) => endOf(b) > at)?.sequence ?? (lastSeq !== null ? lastSeq + 1 : undefined);
  };

  const loadPlaylist = async (): Promise<MediaPlaylist> => {
    const url = (source as LiveSource).mediaUrl;
    const res = await fetchWithTimeout(ctx, url, {}, 20_000);
    if (!res.ok) {
      await res.body?.cancel();
      const code = res.status === 404 || res.status === 410 ? 'not-found' : 'upstream';
      throw new Vid2ContextError(code, `HLS playlist: HTTP ${res.status}`, { status: res.status });
    }
    const pl = parsePlaylist(await res.text(), url);
    if (pl.kind !== 'media') throw new Vid2ContextError('upstream', 'Expected a media playlist and got a master playlist.');
    return pl;
  };

  /** Stream time of a segment: exact durations within a session, nominal ones across gaps. */
  const startOf = (seg: MediaSegment): number =>
    lastSeq === null ? seg.sequence * nominal : lastEndSec + Math.max(0, seg.sequence - lastSeq - 1) * nominal;

  const enforceLag = () => {
    const end = bufferEnd();
    const from = cursor ?? buffer[0]?.startSec;
    const head = from === undefined ? undefined : Math.max(from, inflightEnd ?? from);
    if (end === null || head === undefined || end - head <= maxLagSec) return;
    const target = end - chunkSec;
    while (buffer.length > 1 && endOf(buffer[0] as Buffered) <= target) buffer.shift();
    pushStatus(
      'skipped',
      `Transcription fell ${Math.round(end - head)} s behind the live edge (limit ${maxLagSec} s); skipped ${span(head, target)} to catch up.`,
      buffer[0]?.sequence,
    );
    cursor = target;
    overlapNext = false;
  };

  const download = async (url: string): Promise<Uint8Array> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
      try {
        const res = await fetchWithTimeout(ctx, url, {}, 30_000);
        if (!res.ok) {
          await res.body?.cancel();
          throw new Vid2ContextError('upstream', `media segment: HTTP ${res.status}`, { status: res.status });
        }
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (stop.signal.aborted) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  };

  /** Download every segment of `pl` newer than the last one taken, in order. */
  const take = async (pl: MediaPlaylist, first: boolean) => {
    const firstListed = pl.segments[0]?.sequence ?? pl.mediaSequence;
    if (first) {
      const { start, gap } = chooseStartSequence(pl, { fromSequence: opts.fromSequence, chunkSec });
      if (gap) {
        const sec = Math.round((gap.to - gap.from + 1) * nominal);
        pushStatus(
          'resume-gap',
          `Sequences ${gap.from} to ${gap.to} are no longer in the playlist (about ${sec} s); resuming at ${start}.`,
          start,
        );
      }
      lastSeq = start - 1;
      lastEndSec = start * nominal;
    } else if (lastSeq !== null) {
      const newest = pl.segments.at(-1)?.sequence ?? firstListed;
      if (newest < lastSeq - 2 * Math.max(pl.segments.length, 3)) {
        pushStatus('missed', `The stream restarted its media sequence (now ${firstListed}); continuing with the new segments.`);
        lastSeq = firstListed - 1;
      } else if (firstListed > lastSeq + 1) {
        const missedSec = (firstListed - lastSeq - 1) * nominal;
        pushStatus(
          'missed',
          `Segments ${lastSeq + 1} to ${firstListed - 1} left the playlist before they could be downloaded (${span(lastEndSec, lastEndSec + missedSec)}).`,
        );
      }
    }
    for (const seg of pl.segments) {
      if (stop.signal.aborted) return;
      if (lastSeq !== null && seg.sequence <= lastSeq) continue;
      if (seg.encryption) {
        throw new Vid2ContextError('unsupported-input', `The stream switched to encrypted segments (${seg.encryption}).`, {
          hint: 'Encrypted and DRM-protected HLS streams are not supported.',
        });
      }
      const startSec = startOf(seg);
      let data: Uint8Array;
      try {
        if (seg.initUri && !inits.has(seg.initUri)) inits.set(seg.initUri, await download(seg.initUri));
        data = await download(seg.uri);
      } catch (err) {
        if (stop.signal.aborted) return;
        const why = err instanceof Error ? err.message : String(err);
        pushStatus('missed', `Could not download segment ${seg.sequence} (${span(startSec, startSec + seg.duration)}): ${why}`);
        lastSeq = seg.sequence;
        lastEndSec = startSec + seg.duration;
        continue;
      }
      buffer.push({
        sequence: seg.sequence,
        startSec,
        duration: seg.duration,
        data,
        ...(seg.initUri ? { initUri: seg.initUri } : {}),
        ...(seg.programDateMs !== undefined ? { programDateMs: seg.programDateMs } : {}),
      });
      lastSeq = seg.sequence;
      lastEndSec = startSec + seg.duration;
      enforceLag();
      pulse.notify();
    }
  };

  /** Re-resolve the input (YouTube playlist URLs expire). Returns false when the stream is no longer live. */
  const refreshSource = async (why: string): Promise<boolean> => {
    try {
      source = await resolveLive(input, { registry, ctx }, { language: opts.language });
      pushStatus('refreshed', `Re-resolved the stream URL (${why}).`);
      return true;
    } catch (err) {
      if (err instanceof Vid2ContextError && err.code === 'unsupported-input') {
        finished = 'ended';
        pushStatus('ended', 'The stream is no longer live.', lastSeq !== null ? lastSeq + 1 : undefined);
        return false;
      }
      throw err;
    }
  };

  const producer = async (firstPlaylist: MediaPlaylist, deadline: number) => {
    let playlist: MediaPlaylist | null = firstPlaylist;
    let first = true;
    let failures = 0;
    let fingerprint = '';
    while (!stop.signal.aborted && !finished) {
      let changed = false;
      try {
        if (!playlist) {
          const expires = (source as LiveSource).expiresAtMs;
          if (expires && Date.now() > expires - 60_000 && !(await refreshSource('the signed URL was about to expire'))) break;
          playlist = await loadPlaylist();
        }
        failures = 0;
        nominal = playlist.segments.at(-1)?.duration || playlist.targetDuration || nominal;
        const next = `${playlist.mediaSequence}:${playlist.segments.length}:${playlist.endList}`;
        changed = next !== fingerprint;
        fingerprint = next;
        await take(playlist, first);
        first = false;
        if (playlist.endList) {
          finished = 'ended';
          pushStatus('ended', 'The stream ended (EXT-X-ENDLIST).', lastSeq !== null ? lastSeq + 1 : undefined);
          break;
        }
      } catch (err) {
        if (stop.signal.aborted) break;
        if (isInputError(err)) {
          fatal = err;
          break;
        }
        failures++;
        const status = err instanceof Vid2ContextError ? err.status : undefined;
        const why = err instanceof Error ? err.message : String(err);
        if ((source as LiveSource).ref.platform === 'youtube' && (status === 403 || status === 404) && failures <= 2) {
          if (!(await refreshSource(`the playlist answered HTTP ${status}`).catch(() => false))) {
            finished ??= 'lost';
            break;
          }
        } else if (failures >= MAX_PLAYLIST_FAILURES) {
          finished = 'lost';
          pushStatus('playlist-error', `Lost the stream after ${failures} failed playlist requests: ${why}`, resumeSequence());
          break;
        } else {
          pushStatus('playlist-error', `Playlist request failed (${why}); retrying.`);
        }
      } finally {
        playlist = null;
      }
      if (Date.now() >= deadline) {
        finished = 'max-minutes';
        pushStatus('stopping', `Reached maxMinutes (${opts.maxMinutes}); finishing the buffered audio.`);
        break;
      }
      // RFC 8216 6.3.4: reload after the target duration, or half of it when the playlist did not change.
      const target = Math.max(nominal, 1);
      const backoff = failures > 0 ? Math.min(2 ** failures, 8) : 1;
      const waitMs = (changed ? target : target / 2) * 1000 * backoff;
      try {
        await sleep(Math.min(waitMs, Math.max(0, deadline - Date.now())), stop.signal);
      } catch {
        break;
      }
    }
  };

  try {
    source = await resolveLive(input, { registry, ctx }, { language: opts.language });
    const firstPlaylist = await loadPlaylist();
    if (firstPlaylist.endList) {
      throw new Vid2ContextError('unsupported-input', 'This stream has already ended (its playlist carries EXT-X-ENDLIST).', {
        hint: NOT_LIVE_HINT,
      });
    }
    const encrypted = firstPlaylist.segments.find((s) => s.encryption);
    if (encrypted) {
      throw new Vid2ContextError('unsupported-input', `This stream is encrypted (${encrypted.encryption}).`, {
        hint: 'Encrypted and DRM-protected HLS streams are not supported.',
      });
    }
    nominal = firstPlaylist.segments[0]?.duration || firstPlaylist.targetDuration || 1;

    const title = source.title ? `"${source.title}"` : source.ref.id;
    yield {
      type: 'status',
      code: 'started',
      message: `Watching ${title}: ${chunkSec} s chunks with ${overlapSec} s overlap, speech-to-text starting with ${topRung.id}.`,
    };
    if (topRung.tier === 'keyless') {
      yield {
        type: 'status',
        code: 'keyless-only',
        message:
          `Only keyless speech-to-text is available (${topRung.id}). It allows about 2 requests per minute, which ${chunkSec} s chunks only barely fit. ` +
          'For streams longer than a few minutes, set a free GROQ_API_KEY or a local rung (LOCAL_STT_BASE_URL).',
      };
    }

    const deadline = opts.maxMinutes ? Date.now() + opts.maxMinutes * 60_000 : Number.POSITIVE_INFINITY;
    running = producer(firstPlaylist, deadline)
      .catch((err) => {
        if (!stop.signal.aborted) fatal = err;
      })
      .finally(() => pulse.notify());

    let prevTail: string[] = [];
    let lastRung: string | undefined;
    let retries = 0;

    while (true) {
      while (statuses.length > 0) yield statuses.shift() as LiveEvent;
      if (fatal) throw fatal;
      if (stop.signal.aborted) {
        reason = 'cancelled';
        break;
      }
      if (cursor === null && buffer[0]) cursor = buffer[0].startSec;
      const end = bufferEnd();
      const avail = end !== null && cursor !== null ? end - cursor : 0;
      if (!(avail >= chunkSec || (finished !== null && avail >= MIN_TAIL_SEC))) {
        if (finished) {
          reason = finished;
          break;
        }
        await pulse.wait(stop.signal);
        continue;
      }

      const windowStart = cursor as number;
      const chunkStart = Math.max(windowStart - (overlapNext ? overlapSec : 0), (buffer[0] as Buffered).startSec);
      // Behind by two chunks or more: take several at once, so a rate-limited rung needs fewer requests to catch up.
      const chunkLen = avail >= 2 * chunkSec ? Math.min(avail, chunkSec * catchUpChunks) : chunkSec;
      const chunkEnd = Math.min(windowStart + chunkLen, end as number);
      const parts = buffer.filter((b) => endOf(b) > chunkStart && b.startSec < chunkEnd);
      const firstPart = parts[0] as Buffered;
      const init = firstPart.initUri ? inits.get(firstPart.initUri) : undefined;
      const media: ChunkMedia = {
        data: concat([...(init ? [init] : []), ...parts.map((p) => p.data)]),
        offsetSec: chunkStart - firstPart.startSec,
        durationSec: chunkEnd - chunkStart,
        filename: `live-${firstPart.sequence}.wav`,
      };
      const useOverlap = overlapNext;
      inflightEnd = chunkEnd;

      let audio: Awaited<ReturnType<typeof extractor.extract>>;
      try {
        audio = await extractor.extract(media, stop.signal);
      } catch (err) {
        inflightEnd = null;
        if (stop.signal.aborted) {
          reason = 'cancelled';
          break;
        }
        if (err instanceof Vid2ContextError && err.code === 'no-provider') throw err;
        const why = err instanceof Error ? err.message : String(err);
        yield { type: 'status', code: 'skipped', message: `Could not decode ${span(chunkStart, chunkEnd)}, skipped it: ${why}` };
        cursor = Math.max(cursor ?? chunkEnd, chunkEnd);
        overlapNext = false;
        continue;
      }

      let result: Awaited<ReturnType<typeof transcribe>>;
      try {
        const sttSignal = AbortSignal.any([stop.signal, AbortSignal.timeout(Math.max(90, chunkSec * 4) * 1000)]);
        result = await transcribe(
          registry,
          source.ref,
          audio,
          { stt: opts.language ? { language: opts.language } : {}, chain },
          { ...ctx, signal: sttSignal },
        );
        retries = 0;
      } catch (err) {
        inflightEnd = null;
        if (stop.signal.aborted) {
          reason = 'cancelled';
          break;
        }
        if (isInputError(err)) throw err;
        if (err instanceof Vid2ContextError && err.code === 'no-provider') throw err;
        retries++;
        const waitSec = Math.min(5 * 2 ** (retries - 1), 30);
        const detail = describeAttempts(attemptsOf(err)) || (err instanceof Error ? err.message : String(err));
        yield {
          type: 'status',
          code: 'stt-retry',
          message: `Speech-to-text failed for ${span(chunkStart, chunkEnd)} (${detail}); retrying in ${waitSec} s. Lag grows meanwhile, up to ${maxLagSec} s.`,
        };
        try {
          await sleep(waitSec * 1000, stop.signal);
        } catch {
          reason = 'cancelled';
          break;
        }
        continue;
      }

      const rung = result.transcript.producer;
      const fallbacks = describeAttempts(result.attempts);
      if (rung !== lastRung || fallbacks) {
        const tier = registry.sttRungs(env).find((r) => r.id === rung)?.tier;
        yield {
          type: 'status',
          code: 'rung',
          message: `Transcribed ${span(chunkStart, chunkEnd)} with ${rung}${tier ? ` (${tier})` : ''}${fallbacks ? ` after ${fallbacks}` : ''}.`,
        };
        lastRung = rung;
      }
      producers.add(rung);
      if (result.transcript.model) models.add(result.transcript.model);
      if (!language && result.transcript.language && result.transcript.language !== 'und') language = result.transcript.language;

      const shifted: Segment[] = result.transcript.segments
        .map((s) => ({
          ...s,
          startSec: Math.min(chunkStart + s.startSec, chunkEnd),
          endSec: Math.min(chunkStart + s.endSec, chunkEnd),
          text: s.text.trim(),
        }))
        .filter((s) => s.text.length > 0);
      const fresh = useOverlap ? dedupeOverlap(prevTail, shifted, windowStart).segments : shifted;

      // A skip while this chunk was being transcribed moves the cursor past it; never move it back.
      const skipped = cursor !== null && cursor > windowStart;
      cursor = Math.max(cursor ?? chunkEnd, chunkEnd);
      inflightEnd = null;
      overlapNext = !skipped && overlapSec > 0;
      while (buffer.length > 1 && endOf(buffer[0] as Buffered) <= cursor - overlapSec) buffer.shift();

      const resumeAt = resumeSequence() ?? firstPart.sequence;
      for (const seg of fresh) {
        const part = parts.find((p) => seg.startSec < endOf(p)) ?? firstPart;
        const at =
          part.programDateMs !== undefined
            ? new Date(part.programDateMs + (seg.startSec - part.startSec) * 1000).toISOString()
            : undefined;
        segments.push(seg);
        yield { type: 'segment', segment: seg, ...(at ? { at } : {}), resumeSequence: resumeAt };
      }
      prevTail = [...prevTail, ...wordsOf(fresh)].slice(-TAIL_WORDS);
    }
  } finally {
    stop.abort(new DOMException('Stopped', 'AbortError'));
    for (const s of outer) s.removeEventListener('abort', onOuterAbort);
    await running;
  }

  while (statuses.length > 0) yield statuses.shift() as LiveEvent;
  const transcript: Transcript = {
    ref: (source as LiveSource).ref,
    language: language ?? opts.language ?? 'und',
    origin: 'stt',
    producer: [...producers].join(',') || 'live',
    ...(models.size > 0 ? { model: [...models].join(',') } : {}),
    segments,
    createdAt: new Date().toISOString(),
  };
  const resumeAt = resumeSequence();
  yield { type: 'done', transcript, reason, ...(resumeAt !== undefined ? { resumeSequence: resumeAt } : {}) };
}
