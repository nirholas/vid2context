/**
 * The video-to-context pipeline:
 *
 *   resolve input -> metadata -> transcript -> (comments) -> save
 *
 * Transcript strategy by mode:
 *   auto      captions (creator, then auto, then translated) -> audio + speech-to-text rung chain
 *   captions  captions only, never download audio
 *   stt       skip captions, always transcribe the audio
 *   video     a multimodal video rung reads the whole video (transcript + on-screen notes)
 */
import type { AudioSplitter } from './audio-split.ts';
import { attemptsOf, runChain } from './chain.ts';
import { Vid2ContextError } from './errors.ts';
import {
  audioDurationSec,
  audioExceedsRung,
  durationLimitFrom,
  everyRungTooLarge,
  exceedsEveryRung,
  fetchAudioBytes,
  guardSegments,
  hasDecoderLoop,
  loopRetryTargetSec,
  MIN_LOOP_SPLIT_SEC,
  transcribeLong,
} from './longform/transcribe-long.ts';
import type { ChainOptions, ChatRequest, ChatResult, LlmRung, SourceProvider, SttOptions, SttRung } from './provider.ts';
import type { Registry } from './registry.ts';
import { enforceInputPolicy } from './security/input.ts';
import type { Storage } from './storage.ts';
import { tracedStage } from './telemetry/instrument.ts';
import type { Attempt, AudioInput, Ctx, Transcript, VideoContext, VideoMetadata, VideoRef } from './types.ts';

export type TranscriptMode = 'auto' | 'captions' | 'stt' | 'video';

export interface GetContextOptions {
  mode?: TranscriptMode;
  /** Preferred transcript language (BCP-47). */
  language?: string;
  /** Allow platform auto-captions. Default true. */
  allowAuto?: boolean;
  /** Allow a platform machine translation into `language` (YouTube's translated tracks). Default true. */
  allowTranslated?: boolean;
  /** Rung chain options for the stt/video stages. */
  chain?: ChainOptions;
  stt?: SttOptions;
  /** Fetch comments too: true for the source default, or a number for a limit. */
  comments?: boolean | number;
  /** Cache and library backend. Hits are returned without network calls; results are saved. */
  storage?: Storage | null;
  /** Ignore a cached result and rebuild. */
  refresh?: boolean;
  /** Extra audio splitters for long audio (an ffmpeg splitter for m4a, opus, webm). The built-in MP3 and WAV splitters are always available. */
  splitters?: AudioSplitter[];
  /** Called at stage boundaries (resolve, metadata, captions, audio, stt, video, saving, done), for job progress. */
  onProgress?: (event: { stage: Attempt['stage'] | 'saving' | 'done'; detail?: string }) => void;
}

function now(): string {
  return new Date().toISOString();
}

function errInfo(err: unknown): { reason: string; detail: string } {
  if (err instanceof Vid2ContextError) return { reason: err.code, detail: err.message.slice(0, 300) };
  return { reason: 'error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
}

function cacheUsable(cached: VideoContext, opts: GetContextOptions): boolean {
  if (opts.language && !cached.transcript.language.toLowerCase().startsWith(opts.language.toLowerCase())) return false;
  const origin = cached.transcript.origin;
  if (opts.mode === 'stt' && origin !== 'stt') return false;
  if (opts.mode === 'video' && origin !== 'video-model') return false;
  if (opts.mode === 'captions' && (origin === 'stt' || origin === 'video-model')) return false;
  if (opts.allowAuto === false && origin === 'auto-captions') return false;
  if (opts.allowTranslated === false && cached.transcript.translated) return false;
  return true;
}

export interface ExpandOptions {
  limit?: number;
  /**
   * When the input is a video inside a list (a YouTube watch URL with list=),
   * expand the list instead of returning the video. Inputs without a list are
   * unaffected.
   */
  list?: boolean;
}

/** Resolve an input and expand playlists/channels/feeds into video refs. */
export async function expandInput(registry: Registry, input: string, ctx: Ctx, opts: ExpandOptions = {}): Promise<VideoRef[]> {
  await enforceInputPolicy(input, ctx);
  const resolved = registry.resolve(input);
  const { source } = resolved;
  const ref = opts.list && resolved.list ? resolved.list : resolved.ref;
  if (ref.kind === 'video') return [ref];
  if (!source.listItems) {
    throw new Vid2ContextError('unsupported-input', `${source.name} cannot list the items of a ${ref.kind} yet.`, {
      hint: 'Pass individual video URLs instead.',
    });
  }
  const out: VideoRef[] = [];
  for await (const item of source.listItems(ref, ctx, { limit: opts.limit })) {
    out.push(item);
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

async function fetchCaptions(
  registry: Registry,
  ref: VideoRef,
  opts: GetContextOptions,
  ctx: Ctx,
  attempts: Attempt[],
  seen: { blocked?: Vid2ContextError } = {},
): Promise<Transcript | null> {
  for (const provider of registry.captions(ctx.env).filter((p) => p.supports(ref))) {
    const started = Date.now();
    try {
      const t = await provider.getCaptions(
        ref,
        { language: opts.language, allowAuto: opts.allowAuto ?? true, allowTranslated: opts.allowTranslated ?? true },
        ctx,
      );
      if (t && t.segments.length > 0) {
        attempts.push({ id: provider.id, stage: 'captions', outcome: 'ok', detail: t.origin, ms: Date.now() - started });
        return t;
      }
      attempts.push({ id: provider.id, stage: 'captions', outcome: 'empty', reason: 'no-tracks', ms: Date.now() - started });
    } catch (err) {
      if (err instanceof Vid2ContextError && err.code === 'blocked') seen.blocked ??= err;
      attempts.push({ id: provider.id, stage: 'captions', outcome: 'error', ...errInfo(err), ms: Date.now() - started });
      ctx.log.warn('captions provider failed', { provider: provider.id, ...errInfo(err) });
    }
  }
  return null;
}

/**
 * What to do next when no rung produced a transcript, read from what was
 * actually tried, so the hint never suggests installing something that ran.
 */
export function noTranscriptHint(attempts: Attempt[]): string {
  const audio = attempts.filter((a) => a.stage === 'audio');
  const stt = attempts.filter((a) => a.stage === 'stt');
  if (audio.some((a) => a.reason === 'no-audio-provider')) {
    return 'No installed source could download the audio to transcribe. Install the yt-dlp provider (it covers most sites) and enable a speech-to-text rung.';
  }
  if (audio.length > 0 && !audio.some((a) => a.outcome === 'ok')) {
    const why = [...new Set(audio.map((a) => a.reason).filter(Boolean))].join(', ');
    return `The audio could not be downloaded${why ? ` (${why})` : ''}, so there was nothing to transcribe. See \`attempts\`; a block usually clears within the hour, or run it on your own machine.`;
  }
  if (audio.some((a) => a.outcome === 'ok') && !stt.some((a) => a.outcome === 'ok')) {
    return stt.length === 0
      ? 'The audio was downloaded but no speech-to-text rung is enabled. Add a free key (GROQ_API_KEY) or run whisper.cpp locally.'
      : 'The audio was downloaded but every speech-to-text rung failed. See `attempts` for each one; adding a free key (GROQ_API_KEY) or a local whisper.cpp adds rungs.';
  }
  return 'Check `attempts` for why each step failed.';
}

async function fetchAudio(
  registry: Registry,
  source: SourceProvider,
  ref: VideoRef,
  ctx: Ctx,
  attempts: Attempt[],
): Promise<AudioInput | null> {
  const candidates = [source, ...registry.sources().filter((s) => s !== source)].filter(
    (s) => s.getAudio && (s === source ? (s.canProvideAudio?.(ref, ctx) ?? true) : (s.canProvideAudio?.(ref, ctx) ?? false)),
  );
  for (const s of candidates) {
    const started = Date.now();
    try {
      const audio = await s.getAudio?.(ref, ctx);
      if (audio) {
        attempts.push({ id: s.id, stage: 'audio', outcome: 'ok', ms: Date.now() - started });
        return audio;
      }
    } catch (err) {
      attempts.push({ id: s.id, stage: 'audio', outcome: 'error', ...errInfo(err), ms: Date.now() - started });
      ctx.log.warn('audio provider failed', { provider: s.id, ...errInfo(err) });
    }
  }
  if (candidates.length === 0) {
    attempts.push({
      id: 'audio',
      stage: 'audio',
      outcome: 'skipped',
      reason: 'no-audio-provider',
      detail: `No installed source can supply audio for ${ref.platform}. The yt-dlp provider covers most sites.`,
    });
  }
  return null;
}

/**
 * Every speech-to-text rung turns URL audio into bytes itself, so a chain that
 * falls through N rungs would download the same audio N times, each with its
 * own long timeout. Download it once here instead (capped by
 * VID2CONTEXT_MAX_AUDIO_MB). Having bytes also lets rungs whose upload limit is
 * too small be skipped up front, and lets refused-as-too-large audio go to the
 * long-audio orchestrator, both of which only work on bytes.
 */
async function downloadOnce(registry: Registry, audio: AudioInput, ctx: Ctx): Promise<AudioInput> {
  if (audio.kind !== 'url' || registry.sttRungs(ctx.env).length === 0) return audio;
  const started = Date.now();
  try {
    return await fetchAudioBytes(audio, ctx);
  } catch (err) {
    const attempt: Attempt = {
      id: 'stt/audio-download',
      stage: 'audio',
      outcome: 'error',
      ...errInfo(err),
      ms: Date.now() - started,
    };
    throw Object.assign(err as object, { attempts: [...attemptsOf(err), attempt] });
  }
}

/**
 * Run the speech-to-text rung chain on audio. Rungs whose upload limit is below the audio size are skipped.
 * Audio larger than every rung accepts, or refused as too large by every rung, goes to the long-audio orchestrator.
 */
export async function transcribe(
  registry: Registry,
  ref: VideoRef,
  input: AudioInput,
  opts: { stt?: SttOptions; chain?: ChainOptions; splitters?: AudioSplitter[]; storage?: Storage | null },
  ctx: Ctx,
): Promise<{ transcript: Transcript; attempts: Attempt[] }> {
  const audio = await downloadOnce(registry, input, ctx);
  if (exceedsEveryRung(registry, audio, opts.chain, ctx)) {
    const long = await transcribeLong(registry, ref, audio, opts, ctx);
    return { transcript: long.transcript, attempts: long.attempts };
  }
  const pre: Attempt[] = [];
  const rungs = registry.sttRungs(ctx.env).filter((r) => {
    if (audio.kind === 'bytes' && audioExceedsRung(r, audio)) {
      const size = audio.data.byteLength;
      const detail =
        r.maxBytes !== undefined && size > r.maxBytes
          ? `${size} > ${r.maxBytes} bytes`
          : `${audio.durationSec?.toFixed(1)}s > ${r.maxDurationSec}s`;
      pre.push({ id: r.id, stage: 'stt', outcome: 'skipped', reason: 'too-large', detail });
      return false;
    }
    return true;
  });
  // Speaker labels need a rung that can diarize; without this the chain would answer from Whisper with no speakers.
  const diarize = opts.stt?.diarize === true;
  const sttChain: ChainOptions = diarize
    ? { ...opts.chain, needs: [...(opts.chain?.needs ?? []), 'diarization'] }
    : (opts.chain ?? {});
  try {
    const res = await runChain<SttRung, Awaited<ReturnType<SttRung['transcribe']>>>(
      'stt',
      rungs,
      (rung) => rung.transcribe(audio, opts.stt ?? {}, ctx),
      sttChain,
      ctx,
    );
    const transcript: Transcript = {
      ref,
      language: res.value.language,
      origin: 'stt',
      producer: res.rung.id,
      model: res.value.model,
      segments: res.value.segments,
      createdAt: now(),
    };
    const attempts = [...pre, ...res.attempts];
    // A decoder loop (one phrase repeated over and over) hides the speech under it. Cutting the loop back would
    // lose that speech, so first transcribe the audio again in overlapping pieces, which the long-audio path
    // checks for loops piece by piece. The guard below stays the fallback when that cannot run or fails.
    if (audio.kind === 'bytes' && hasDecoderLoop(transcript.segments)) {
      // The real length, not the looped transcript's last timestamp, which can fall far short and cut many pieces.
      const durationSec = audioDurationSec(audio);
      attempts.push({
        id: res.rung.id,
        stage: 'stt',
        outcome: 'error',
        reason: 'repetition-loop',
        detail: 'the transcript repeats one phrase over and over (a decoder loop); transcribing again in smaller pieces',
      });
      if (durationSec !== undefined && durationSec >= MIN_LOOP_SPLIT_SEC) {
        try {
          const long = await transcribeLong(
            registry,
            ref,
            audio,
            { ...opts, chain: sttChain, targetSec: loopRetryTargetSec(durationSec), splitLoops: false },
            ctx,
          );
          return { transcript: long.transcript, attempts: [...attempts, ...long.attempts] };
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          attempts.push(...attemptsOf(err));
        }
      }
    }
    const guard = guardSegments(transcript.segments);
    transcript.segments = guard.segments;
    if (guard.attempt) attempts.push(guard.attempt);
    return { transcript, attempts };
  } catch (err) {
    // An abort (including one during the loop retry above) ends here: never start another long-audio run for it.
    if (ctx.signal?.aborted) throw err;
    const tried = [...pre, ...attemptsOf(err)];
    if (diarize && err instanceof Vid2ContextError && err.code === 'no-provider') {
      throw Object.assign(
        new Vid2ContextError('no-provider', 'Speaker labels were requested, but no enabled speech-to-text rung can diarize.', {
          stage: 'stt',
          hint: 'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (free) to enable stt/cloudflare/@cf/deepgram/nova-3, or turn speaker labels off.',
          cause: err,
        }),
        { attempts: tried },
      );
    }
    if (audio.kind !== 'bytes' || !everyRungTooLarge(tried)) throw Object.assign(err as object, { attempts: tried });
    try {
      const long = await transcribeLong(registry, ref, audio, { ...opts, maxPieceSec: durationLimitFrom(tried) }, ctx);
      return { transcript: long.transcript, attempts: [...tried, ...long.attempts] };
    } catch (longErr) {
      throw Object.assign(longErr as object, { attempts: [...tried, ...attemptsOf(longErr)] });
    }
  }
}

/** Run the LLM rung chain. */
export async function chat(
  registry: Registry,
  req: ChatRequest,
  chain: ChainOptions,
  ctx: Ctx,
): Promise<ChatResult & { rung: string; attempts: Attempt[] }> {
  const needs = [...(chain.needs ?? [])];
  if (req.json && typeof req.json === 'object' && !needs.includes('json')) needs.push('json');
  const res = await runChain<LlmRung, ChatResult>(
    'llm',
    registry.llmRungs(ctx.env),
    (r) => r.chat(req, ctx),
    { ...chain, needs },
    ctx,
  );
  return { ...res.value, rung: res.rung.id, attempts: res.attempts };
}

function minimalMetadata(ref: VideoRef): VideoMetadata {
  return { ref, title: ref.url ?? ref.input, chapters: [] };
}

/** Turn one input into a full VideoContext. */
export async function getVideoContext(
  registry: Registry,
  input: string,
  opts: GetContextOptions,
  ctx: Ctx,
): Promise<VideoContext> {
  const tel = ctx.telemetry;
  if (!tel) return buildVideoContext(registry, input, opts, ctx);
  return tel.span('vid2context.get_context', { 'vid2context.mode': opts.mode ?? 'auto' }, () =>
    buildVideoContext(registry, input, opts, ctx),
  );
}

async function buildVideoContext(registry: Registry, input: string, opts: GetContextOptions, ctx: Ctx): Promise<VideoContext> {
  const attempts: Attempt[] = [];
  const mode = opts.mode ?? 'auto';
  const tel = ctx.telemetry;
  await enforceInputPolicy(input, ctx);
  const { source, ref } = tel
    ? await tracedStage(tel, 'resolve', undefined, async (span) => {
        const resolved = registry.resolve(input);
        span.setAttributes({ 'vid2context.ref': resolved.ref.id, 'vid2context.platform': resolved.ref.platform });
        return resolved;
      })
    : registry.resolve(input);
  attempts.push({ id: source.id, stage: 'resolve', outcome: 'ok', detail: ref.id });
  opts.onProgress?.({ stage: 'resolve', detail: ref.id });
  if (ref.kind !== 'video') {
    throw new Vid2ContextError('unsupported-input', `"${input}" is a ${ref.kind}, not a single video.`, {
      hint: 'Expand it first (CLI: `vid2context list`, MCP: list_items) or add it to a collection.',
    });
  }

  if (opts.storage && !opts.refresh) {
    const cached = await opts.storage.getContext(ref.id);
    if (cached && cacheUsable(cached, opts)) return cached;
  }

  opts.onProgress?.({ stage: 'metadata' });
  let metadata: VideoMetadata;
  // The first block seen (metadata or captions): when no rung gets a transcript, it is the error to report.
  const seen: { blocked?: Vid2ContextError } = {};
  const mStart = Date.now();
  try {
    metadata = await (tel ? tracedStage(tel, 'metadata', ref, () => source.getMetadata(ref, ctx)) : source.getMetadata(ref, ctx));
    attempts.push({ id: source.id, stage: 'metadata', outcome: 'ok', ms: Date.now() - mStart });
  } catch (err) {
    if (err instanceof Vid2ContextError && (err.code === 'not-found' || err.code === 'unavailable')) {
      throw Object.assign(err, {
        attempts: [...attempts, { id: source.id, stage: 'metadata', outcome: 'error', ...errInfo(err) }],
      });
    }
    // A block is about this server's IP address, not the video: other rungs (a relay, a proxy,
    // yt-dlp, a transcript API, speech-to-text) may still get the transcript, so they get their turn.
    // When none does, the block is what the caller sees (below), with its hint.
    if (err instanceof Vid2ContextError && err.code === 'blocked') {
      seen.blocked = err;
      attempts.push(...attemptsOf(err));
    }
    attempts.push({ id: source.id, stage: 'metadata', outcome: 'error', ...errInfo(err), ms: Date.now() - mStart });
    metadata = minimalMetadata(ref);
  }

  let transcript: Transcript | null = null;
  let visual: VideoContext['visual'];

  if (mode === 'video') {
    opts.onProgress?.({ stage: 'video' });
    const rungs = registry.videoRungs(ctx.env).filter((r) => r.supports(ref));
    try {
      const run = () =>
        runChain('video', rungs, (r) => r.understand(ref, { language: opts.language }, ctx), opts.chain ?? {}, ctx);
      const res = await (tel ? tracedStage(tel, 'video', ref, run) : run());
      attempts.push(...res.attempts);
      transcript = res.value.transcript ?? null;
      visual = res.value.visual;
    } catch (err) {
      attempts.push(...attemptsOf(err));
    }
  }

  if (!transcript && (mode === 'auto' || mode === 'captions')) {
    opts.onProgress?.({ stage: 'captions' });
    transcript = await (tel
      ? tracedStage(tel, 'captions', ref, () => fetchCaptions(registry, ref, opts, ctx, attempts, seen))
      : fetchCaptions(registry, ref, opts, ctx, attempts, seen));
  }

  if (!transcript && (mode === 'auto' || mode === 'stt')) {
    opts.onProgress?.({ stage: 'audio' });
    const audio = await (tel
      ? tracedStage(tel, 'audio', ref, () => fetchAudio(registry, source, ref, ctx, attempts))
      : fetchAudio(registry, source, ref, ctx, attempts));
    if (audio) {
      opts.onProgress?.({ stage: 'stt' });
      try {
        const res = await (tel
          ? tracedStage(tel, 'stt', ref, () => transcribe(registry, ref, audio, opts, ctx))
          : transcribe(registry, ref, audio, opts, ctx));
        attempts.push(...res.attempts);
        transcript = res.transcript;
      } catch (err) {
        attempts.push(...attemptsOf(err));
      }
    }
  }

  // Every rung had its turn; a block is the most useful thing to report, because its hint says how to get past it.
  if (!transcript && seen.blocked) {
    const b = seen.blocked;
    throw Object.assign(
      new Vid2ContextError('blocked', b.message, { hint: b.hint, status: b.status, retryAfterSec: b.retryAfterSec }),
      { attempts },
    );
  }

  if (!transcript) {
    throw Object.assign(
      new Vid2ContextError('no-transcript', `Could not get a transcript for ${ref.id} (mode: ${mode}).`, {
        hint:
          mode === 'captions'
            ? opts.allowAuto === false || opts.allowTranslated === false
              ? 'No captions match: auto-captions or platform translations were refused. Allow them, or retry with mode "auto" or "stt" to transcribe the audio.'
              : 'This video has no captions. Retry with mode "auto" or "stt" to transcribe the audio.'
            : noTranscriptHint(attempts),
      }),
      { attempts },
    );
  }

  const context: VideoContext = { metadata, transcript, attempts };
  if (visual) context.visual = visual;

  if (opts.comments && source.getComments) {
    try {
      const limit = typeof opts.comments === 'number' ? opts.comments : undefined;
      const getComments = source.getComments.bind(source);
      context.comments = await (tel
        ? tracedStage(tel, 'comments', ref, () => getComments(ref, ctx, { limit }))
        : getComments(ref, ctx, { limit }));
    } catch (err) {
      attempts.push({ id: source.id, stage: 'metadata', outcome: 'error', reason: 'comments', detail: errInfo(err).detail });
    }
  }

  const storage = opts.storage;
  if (storage) opts.onProgress?.({ stage: 'saving' });
  if (storage) await (tel ? tracedStage(tel, 'save', ref, () => storage.putContext(context)) : storage.putContext(context));
  opts.onProgress?.({ stage: 'done' });
  return context;
}
