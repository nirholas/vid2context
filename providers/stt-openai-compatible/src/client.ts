/**
 * Client for OpenAI-compatible POST /audio/transcriptions (OpenAI, Groq, OVH,
 * DeepInfra, Together, Mistral, speaches, LocalAI, ...). Plain fetch +
 * FormData, so it runs on Node, Workers and in the browser.
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
import { normalizeLanguage } from './languages.ts';
import { clampPrompt } from './prompt.ts';
import { retryAfterFromHeaders } from './ratelimit.ts';

/**
 * How a service spells the request. `openai` is the OpenAI shape
 * (response_format, timestamp_granularities[], prompt). `mistral` is Mistral's
 * variant: no response_format, `timestamp_granularities=segment` to get
 * segments, `context_bias` instead of `prompt`, `return_language` to report
 * the detected language.
 */
export type Dialect = 'openai' | 'mistral';

export interface Endpoint {
  /** Base URL including /v1 (no trailing slash). */
  baseUrl: string;
  model: string;
  /** Omitted for keyless endpoints: they reject a bogus Authorization header. */
  key?: string;
  /** For error messages: 'ovh', 'groq'. */
  label: string;
  /** Env var that holds the key, for auth hints. */
  keyVar?: string;
  /** Env var that overrides the model, for not-found hints. */
  modelVar?: string;
  maxBytes?: number;
  timeoutMs?: number;
  dialect?: Dialect;
  /** Ask for word timestamps (timestamp_granularities[]=word with verbose_json). */
  words?: boolean;
  /** Longest prompt the service accepts, in characters. Default 800 (Whisper's 224 tokens). */
  promptMaxChars?: number;
  /** Shortest cooldown after a 429, for services with a per-minute window and no Retry-After (OVH). */
  minRetryAfterSec?: number;
}

/** One recognized word with its timing. */
export interface Word {
  word: string;
  startSec: number;
  endSec: number;
}

/** A segment with the words inside it, when the rung has the `words` capability. Assignable to `Segment`. */
export interface WordSegment extends Segment {
  words?: Word[];
}

type BytesAudio = Extract<AudioInput, { kind: 'bytes' }>;

/** Download cap for URL audio when the rung itself has no upload limit. */
export const DEFAULT_DOWNLOAD_CAP = 500 * 1024 * 1024;

/** Extensions the OpenAI transcription API (and its clones) accept. OVH rejects anything else. */
const ACCEPTED = /\.(flac|mp3|mp4|mpeg|mpga|m4a|ogg|oga|opus|wav|webm)$/i;
const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
const MIME_BY_EXT: Record<string, string> = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

/** Make sure the upload filename ends in an extension the API accepts, using the mime type when it does not. */
export function uploadFilename(filename: string, mimeType: string): string {
  if (ACCEPTED.test(filename)) return filename;
  const ext = EXT_BY_MIME[mimeType.split(';')[0]?.trim().toLowerCase() ?? ''];
  return ext ? `${filename.replace(/\.[^./]*$/, '') || 'audio'}.${ext}` : filename;
}

/** A Content-Type that matches the upload: the given one when it is a real audio/video type, else one from the extension. */
export function uploadMimeType(filename: string, mimeType: string): string {
  const m = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (/^(audio|video)\//.test(m)) return m;
  return MIME_BY_EXT[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'audio/mpeg';
}

function tooLarge(bytes: number, ep: Endpoint, cap: number): Vid2ContextError {
  return new Vid2ContextError('too-large', `Audio is ${bytes} bytes; ${ep.label} accepts up to ${cap}.`, {
    hint: 'Split the audio into shorter parts, or use a rung with a larger upload limit (see docs/guides/speech-to-text.md).',
  });
}

/** Read a response body, refusing to buffer more than `cap` bytes even when Content-Length is missing or wrong. */
async function readCapped(res: Response, cap: number, ep: Endpoint): Promise<Uint8Array> {
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > cap) {
    await res.body?.cancel();
    throw tooLarge(length, ep, cap);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw tooLarge(total, ep, cap);
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

async function toBytes(audio: AudioInput, ep: Endpoint, ctx: Ctx): Promise<BytesAudio> {
  if (audio.kind === 'bytes') return audio;
  const res = await fetchWithTimeout(ctx, audio.url, {}, ep.timeoutMs ?? 600_000);
  if (!res.ok) throw await errorFromResponse(res, `audio download for ${ep.label}`);
  const data = await readCapped(res, ep.maxBytes ?? DEFAULT_DOWNLOAD_CAP, ep);
  const name = new URL(audio.url).pathname.split('/').pop() || 'audio';
  return {
    kind: 'bytes',
    data,
    mimeType: audio.mimeType ?? res.headers.get('content-type') ?? 'audio/mpeg',
    filename: name,
    durationSec: audio.durationSec,
  };
}

interface RawWord {
  word?: string;
  text?: string;
  start: number;
  end: number;
}

interface VerboseJson {
  text?: string;
  language?: string | null;
  duration?: number;
  segments?: { start: number; end: number; text: string; words?: RawWord[] }[];
  words?: RawWord[];
}

function toWords(raw: RawWord[] | undefined): Word[] {
  return (raw ?? [])
    .map((w) => ({ word: (w.word ?? w.text ?? '').trim(), startSec: w.start, endSec: w.end }))
    .filter((w) => w.word.length > 0 && Number.isFinite(w.startSec) && Number.isFinite(w.endSec));
}

/** Put each top-level word into the segment that contains its start (or the nearest one before it). */
function attachWords(segments: WordSegment[], words: Word[]): void {
  if (segments.length === 0 || words.length === 0) return;
  let i = 0;
  for (const w of words) {
    while (i + 1 < segments.length && (segments[i + 1]?.startSec ?? Number.POSITIVE_INFINITY) <= w.startSec) i++;
    const seg = segments[i];
    if (!seg) continue;
    if (!seg.words) seg.words = [];
    seg.words.push(w);
  }
}

/**
 * Normalize a transcription response into segments. Handles `verbose_json`
 * (segments, optional top-level or per-segment words), `json` and Mistral
 * responses with only `text`, and plain `text` bodies passed as a string.
 * Without segments the whole text becomes one segment spanning the known
 * duration (from the response, else `durationSec`).
 */
export function parseVerboseJson(
  json: VerboseJson | string,
  fallbackLanguage?: string,
  durationSec?: number,
): { language: string; segments: WordSegment[] } {
  const body: VerboseJson = typeof json === 'string' ? { text: json } : json;
  const segments: WordSegment[] = [];
  for (const s of body.segments ?? []) {
    const text = (s.text ?? '').trim();
    if (!text) continue;
    const seg: WordSegment = { startSec: s.start, endSec: s.end, text };
    const words = toWords(s.words);
    if (words.length > 0) seg.words = words;
    segments.push(seg);
  }
  const text = body.text?.trim();
  if (segments.length === 0 && text) {
    segments.push({ startSec: 0, endSec: body.duration ?? durationSec ?? 0, text });
  }
  if (!segments.some((s) => s.words)) attachWords(segments, toWords(body.words));
  return {
    language: normalizeLanguage(body.language ?? undefined) ?? normalizeLanguage(fallbackLanguage) ?? 'und',
    segments,
  };
}

const MESSAGE_KEYS = ['message', 'detail', 'error'] as const;

/** Pull a human message out of the common error body shapes ({error:{message}}, {detail}, {message}). */
function bodyMessage(body: string): string {
  try {
    let v: unknown = JSON.parse(body);
    for (let depth = 0; depth < 3 && v && typeof v === 'object'; depth++) {
      const o = v as Record<string, unknown>;
      const key = MESSAGE_KEYS.find((k) => o[k] !== undefined && o[k] !== null);
      if (!key) break;
      v = o[key];
    }
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return JSON.stringify(v);
  } catch {
    // Not JSON: use the raw text.
  }
  return body;
}

const TOO_LARGE = /too large|too big|maximum (content |file |upload )?(size|length)|exceeds? .*(size|limit)|file size|payload/i;
const MODEL_MISSING = /model_not_found|model\b.*\b(does not exist|not found|not exist|unknown|is not supported|not available)|unknown model|invalid model|no such model/i;
const UNDECODABLE = /could not (decode|process|read|parse) (the )?(audio|file|media)|failed to (decode|load|read) (the )?(audio|file|media)|invalid (audio|media) file|corrupt|not a valid (audio|media)|unable to (decode|process) (the )?(audio|file)/i;
const BAD_FORMAT = /extension .* not supported|unsupported (file )?(format|extension|media type)|invalid file format|file format .* not supported/i;

/**
 * Turn a failed transcription response into a Vid2ContextError: the core
 * mapping by status, refined from the body (file too large, model not found,
 * undecodable audio), with `retryAfterSec` from Retry-After or the
 * x-ratelimit-* headers.
 */
export async function sttErrorFromResponse(res: Response, ep: Endpoint): Promise<Vid2ContextError> {
  const label = `${ep.label} transcription`;
  let body = '';
  try {
    body = await res.clone().text();
  } catch {
    body = '';
  }
  const base = await errorFromResponse(res, label);
  const message = bodyMessage(body);
  const status = res.status;
  const opts = (hint: string, retryAfterSec?: number) => ({ hint, status, retryAfterSec, cause: base });

  if (status === 429) {
    const fromHeaders = retryAfterFromHeaders(res.headers);
    const retryAfterSec = Math.max(fromHeaders ?? 0, ep.minRetryAfterSec ?? 0) || undefined;
    return new Vid2ContextError(
      'rate-limited',
      base.message,
      opts(`${ep.label} is rate limiting this ${ep.key ? 'key' : 'address'}. The chain moves to the next rung and retries this one later.`, retryAfterSec),
    );
  }
  if (status === 401 || status === 403) {
    return new Vid2ContextError(
      'auth',
      base.message,
      opts(ep.keyVar ? `Check ${ep.keyVar}: ${ep.label} rejected the key.` : `${ep.label} refused the request without a key.`),
    );
  }
  if (status === 413 || (status >= 400 && status < 500 && TOO_LARGE.test(message))) {
    return new Vid2ContextError(
      'too-large',
      base.message,
      opts('Split the audio into shorter parts, or use a rung with a larger upload limit (see docs/guides/speech-to-text.md).'),
    );
  }
  if (MODEL_MISSING.test(message) || (status === 404 && /model/i.test(message))) {
    return new Vid2ContextError(
      'not-found',
      base.message,
      opts(`${ep.label} does not serve model "${ep.model}".${ep.modelVar ? ` Set ${ep.modelVar} to a model it lists.` : ''}`),
    );
  }
  if (status >= 400 && status < 500 && UNDECODABLE.test(message)) {
    return new Vid2ContextError(
      'bad-request',
      base.message,
      opts('The audio could not be decoded. Check that the file plays, or re-encode it (for example to mp3) and try again.'),
    );
  }
  if (status >= 400 && status < 500 && BAD_FORMAT.test(message)) {
    return new Vid2ContextError(
      'upstream',
      base.message,
      opts(`${ep.label} rejected the file format. Another rung may accept it; re-encoding to mp3 works everywhere.`),
    );
  }
  if (status >= 500) {
    return new Vid2ContextError(
      'upstream',
      base.message,
      opts(`${ep.label} had a server error. The chain tries the next rung.`, retryAfterFromHeaders(res.headers)),
    );
  }
  return base;
}

function buildForm(ep: Endpoint, audio: BytesAudio, opts: SttOptions): FormData {
  const filename = uploadFilename(audio.filename, audio.mimeType);
  const form = new FormData();
  form.append('file', new Blob([audio.data.slice()], { type: uploadMimeType(filename, audio.mimeType) }), filename);
  form.append('model', ep.model);
  const language = normalizeLanguage(opts.language)?.split(/[-_]/)[0]?.toLowerCase();
  const prompt = opts.prompt ? clampPrompt(opts.prompt, ep.promptMaxChars ?? 800) : '';
  if (ep.dialect === 'mistral') {
    form.append('timestamp_granularities', 'segment');
    if (language) form.append('language', language);
    else form.append('return_language', 'true');
    if (prompt) form.append('context_bias', prompt);
    return form;
  }
  form.append('response_format', 'verbose_json');
  if (ep.words) {
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
  }
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  return form;
}

export async function transcribeWith(ep: Endpoint, input: AudioInput, opts: SttOptions, ctx: Ctx): Promise<SttResult> {
  const audio = await toBytes(input, ep, ctx);
  if (ep.maxBytes && audio.data.byteLength > ep.maxBytes) throw tooLarge(audio.data.byteLength, ep, ep.maxBytes);

  const res = await fetchWithTimeout(
    ctx,
    `${ep.baseUrl}/audio/transcriptions`,
    { method: 'POST', headers: ep.key ? { authorization: `Bearer ${ep.key}` } : {}, body: buildForm(ep, audio, opts) },
    ep.timeoutMs ?? 600_000,
  );
  if (!res.ok) throw await sttErrorFromResponse(res, ep);
  const raw = await res.text();
  let body: VerboseJson | string = raw;
  if (!/^text\/plain/i.test(res.headers.get('content-type') ?? '')) {
    try {
      body = JSON.parse(raw) as VerboseJson;
    } catch {
      body = raw;
    }
  }
  const parsed = parseVerboseJson(body, opts.language, audio.durationSec);
  return { ...parsed, model: ep.model };
}
