/**
 * Workers AI speech-to-text.
 *
 *   @cf/openai/whisper-large-v3-turbo  JSON { audio: <base64> }, returns segments, words and the detected language.
 *   @cf/openai/whisper                 legacy model: raw bytes over REST, { audio: number[] } through the binding.
 *                                      Returns words and a VTT whose first cue has no start time, so segments
 *                                      are rebuilt from the words. Reports no language.
 *   @cf/deepgram/nova-3                Deepgram hosted by Cloudflare: raw bytes over REST with Deepgram's feature
 *                                      flags as URL parameters. With diarize=true it labels speakers, which no
 *                                      Whisper model does. REST only: the binding input for it is not verified.
 *
 * Input formats verified against the live models on 2026-11-14 (see test/fixtures/README.md).
 */
import {
  type AudioInput,
  type Ctx,
  errorFromResponse,
  fetchWithTimeout,
  type Segment,
  type SttOptions,
  type SttResult,
  Vid2ContextError,
} from '@vid2context/core';
import { runModel, type Transport, toBase64 } from './transport.ts';

type BytesAudio = Extract<AudioInput, { kind: 'bytes' }>;

/** Models that take raw bytes (REST) or a byte array (binding) instead of base64 JSON. */
export const LEGACY_WHISPER = new Set(['@cf/openai/whisper', '@cf/openai/whisper-tiny-en']);

interface TurboOutput {
  transcription_info?: { language?: string; duration?: number };
  text?: string;
  segments?: { start: number; end: number; text: string }[];
}

interface Word {
  word: string;
  start: number;
  end: number;
}

interface LegacyOutput {
  text?: string;
  words?: Word[];
}

function primaryLanguage(lang: string | undefined): string | undefined {
  const l = lang?.split(/[-_]/)[0]?.toLowerCase();
  return l && /^[a-z]{2,3}$/.test(l) ? l : undefined;
}

export function parseTurbo(out: TurboOutput, fallbackLanguage?: string): { language: string; segments: Segment[] } {
  const segments: Segment[] = (out.segments ?? [])
    .map((s) => ({ startSec: s.start, endSec: s.end, text: s.text.trim() }))
    .filter((s) => s.text.length > 0);
  const text = out.text?.trim();
  if (segments.length === 0 && text) segments.push({ startSec: 0, endSec: out.transcription_info?.duration ?? 0, text });
  return {
    language: primaryLanguage(out.transcription_info?.language) ?? primaryLanguage(fallbackLanguage) ?? 'und',
    segments,
  };
}

/**
 * Group word timings into caption-sized segments: break after sentence
 * punctuation, at a pause longer than 1 s, or every 24 words.
 */
export function segmentsFromWords(words: Word[]): Segment[] {
  const out: Segment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    const text = cur
      .map((w) => w.word.trim())
      .filter(Boolean)
      .join(' ');
    const first = cur[0];
    const last = cur.at(-1);
    if (text && first && last) out.push({ startSec: first.start, endSec: last.end, text });
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && w.start - prev.end > 1) flush();
    cur.push(w);
    if (/[.!?]["')\]]*$/.test(w.word.trim()) || cur.length >= 24) flush();
  }
  flush();
  return out;
}

export function parseLegacy(out: LegacyOutput, fallbackLanguage?: string): { language: string; segments: Segment[] } {
  const segments = segmentsFromWords(out.words ?? []);
  const text = out.text?.trim();
  if (segments.length === 0 && text) segments.push({ startSec: 0, endSec: 0, text });
  return { language: primaryLanguage(fallbackLanguage) ?? 'und', segments };
}

/** Deepgram models served by Workers AI (raw audio body, flags in the query string). */
export function isDeepgramModel(model: string): boolean {
  return model.startsWith('@cf/deepgram/');
}

interface DeepgramUtterance {
  start: number;
  end: number;
  transcript: string;
  confidence?: number;
  speaker?: number;
  languages?: string[];
}

interface DeepgramSentence {
  text: string;
  start: number;
  end: number;
}

interface DeepgramOutput {
  results?: {
    utterances?: DeepgramUtterance[];
    channels?: {
      detected_language?: string;
      alternatives?: {
        transcript?: string;
        confidence?: number;
        languages?: string[];
        paragraphs?: { paragraphs?: { speaker?: number; sentences?: DeepgramSentence[] }[] };
      }[];
    }[];
  };
}

/**
 * Deepgram's feature flags. Speaker labels only when asked for; language
 * detection unless the caller names the language.
 */
export function deepgramQuery(opts: SttOptions): Record<string, string> {
  const q: Record<string, string> = {
    diarize: opts.diarize ? 'true' : 'false',
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
    paragraphs: 'true',
  };
  const language = primaryLanguage(opts.language);
  if (language) q.language = language;
  else q.detect_language = 'true';
  return q;
}

/**
 * Utterances become segments (with `Speaker N` when diarizing); paragraph
 * sentences, then the whole transcript, are the fallbacks.
 */
export function parseDeepgram(
  out: DeepgramOutput,
  diarize: boolean,
  fallbackLanguage?: string,
): { language: string; segments: Segment[] } {
  const channel = out.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  const utterances = out.results?.utterances ?? [];
  const label = (n: number | undefined) => (diarize && typeof n === 'number' ? { speaker: `Speaker ${n}` } : {});
  let segments: Segment[] = utterances
    .map((u) => ({
      startSec: u.start,
      endSec: u.end,
      text: u.transcript.trim(),
      ...label(u.speaker),
      ...(typeof u.confidence === 'number' ? { confidence: u.confidence } : {}),
    }))
    .filter((s) => s.text.length > 0);
  if (segments.length === 0) {
    segments = (alt?.paragraphs?.paragraphs ?? []).flatMap((p) =>
      (p.sentences ?? [])
        .map((s) => ({ startSec: s.start, endSec: s.end, text: s.text.trim(), ...label(p.speaker) }))
        .filter((s) => s.text.length > 0),
    );
  }
  const text = alt?.transcript?.trim();
  if (segments.length === 0 && text) segments.push({ startSec: 0, endSec: 0, text });
  const detected =
    channel?.detected_language ?? alt?.languages?.[0] ?? utterances.find((u) => u.languages?.length)?.languages?.[0];
  return { language: primaryLanguage(detected) ?? primaryLanguage(fallbackLanguage) ?? 'und', segments };
}

async function toBytes(audio: AudioInput, ctx: Ctx, label: string): Promise<BytesAudio> {
  if (audio.kind === 'bytes') return audio;
  const res = await fetchWithTimeout(ctx, audio.url, {}, 600_000);
  if (!res.ok) throw await errorFromResponse(res, `audio download for ${label}`);
  return {
    kind: 'bytes',
    data: new Uint8Array(await res.arrayBuffer()),
    mimeType: audio.mimeType ?? res.headers.get('content-type') ?? 'audio/mpeg',
    filename: new URL(audio.url).pathname.split('/').pop() || 'audio',
    durationSec: audio.durationSec,
  };
}

export async function transcribe(
  t: Transport,
  model: string,
  input: AudioInput,
  opts: SttOptions,
  ctx: Ctx,
  label: string,
): Promise<SttResult> {
  const audio = await toBytes(input, ctx, label);
  if (audio.data.byteLength === 0) throw new Vid2ContextError('bad-request', `${label}: the audio is empty.`);
  if (isDeepgramModel(model)) {
    if (t.kind !== 'rest') {
      throw new Vid2ContextError('bad-request', `${label}: Deepgram models run over REST only.`, {
        hint: 'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN and use the stt/cloudflare/... rung.',
      });
    }
    const result = (await runModel(
      ctx,
      t,
      model,
      { bytes: audio.data, contentType: audio.mimeType || 'audio/mpeg', json: {}, query: deepgramQuery(opts) },
      { label, timeoutMs: 600_000 },
    )) as DeepgramOutput;
    return { ...parseDeepgram(result, Boolean(opts.diarize), opts.language), model };
  }
  if (LEGACY_WHISPER.has(model)) {
    const result = (await runModel(
      ctx,
      t,
      model,
      { bytes: audio.data, contentType: audio.mimeType || 'application/octet-stream', json: {} },
      { label, timeoutMs: 600_000, bindingInput: { audio: Array.from(audio.data) } },
    )) as LegacyOutput;
    return { ...parseLegacy(result, opts.language), model };
  }
  const json: Record<string, unknown> = { audio: toBase64(audio.data) };
  const language = primaryLanguage(opts.language);
  if (language) json.language = language;
  if (opts.prompt) json.initial_prompt = opts.prompt;
  const result = (await runModel(ctx, t, model, { json }, { label, timeoutMs: 600_000 })) as TurboOutput;
  return { ...parseTurbo(result, opts.language), model };
}
