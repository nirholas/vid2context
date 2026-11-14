/**
 * Client for OpenAI-compatible POST /audio/transcriptions (OpenAI, Groq, OVH,
 * speaches, faster-whisper-server, LocalAI, ...). Plain fetch + FormData, so
 * it runs on Node, Workers and in the browser.
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

export interface Endpoint {
  /** Base URL including /v1 (no trailing slash). */
  baseUrl: string;
  model: string;
  /** Omitted for keyless endpoints: they reject a bogus Authorization header. */
  key?: string;
  /** For error messages: 'ovh', 'groq'. */
  label: string;
  maxBytes?: number;
  timeoutMs?: number;
}

type BytesAudio = Extract<AudioInput, { kind: 'bytes' }>;

/** Extensions the OpenAI transcription API (and its clones) accept. OVH rejects anything else. */
const ACCEPTED = /\.(flac|mp3|mp4|mpeg|mpga|m4a|ogg|oga|opus|wav|webm)$/i;
const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
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

/** Make sure the upload filename ends in an extension the API accepts, using the mime type when it does not. */
export function uploadFilename(filename: string, mimeType: string): string {
  if (ACCEPTED.test(filename)) return filename;
  const ext = EXT_BY_MIME[mimeType.split(';')[0]?.trim().toLowerCase() ?? ''];
  return ext ? `${filename.replace(/\.[^./]*$/, '') || 'audio'}.${ext}` : filename;
}

async function toBytes(audio: AudioInput, ep: Endpoint, ctx: Ctx): Promise<BytesAudio> {
  if (audio.kind === 'bytes') return audio;
  const res = await fetchWithTimeout(ctx, audio.url, {}, ep.timeoutMs ?? 600_000);
  if (!res.ok) throw await errorFromResponse(res, `audio download for ${ep.label}`);
  const length = Number(res.headers.get('content-length'));
  if (ep.maxBytes && Number.isFinite(length) && length > ep.maxBytes) {
    throw new Vid2ContextError('too-large', `Audio is ${length} bytes; ${ep.label} accepts up to ${ep.maxBytes}.`);
  }
  const data = new Uint8Array(await res.arrayBuffer());
  const name = new URL(audio.url).pathname.split('/').pop() || 'audio';
  return {
    kind: 'bytes',
    data,
    mimeType: audio.mimeType ?? res.headers.get('content-type') ?? 'audio/mpeg',
    filename: name,
    durationSec: audio.durationSec,
  };
}

interface VerboseJson {
  text?: string;
  language?: string;
  duration?: number;
  segments?: { start: number; end: number; text: string }[];
}

export function parseVerboseJson(json: VerboseJson, fallbackLanguage?: string): { language: string; segments: Segment[] } {
  const segments: Segment[] = (json.segments ?? [])
    .map((s) => ({ startSec: s.start, endSec: s.end, text: s.text.trim() }))
    .filter((s) => s.text.length > 0);
  const text = json.text?.trim();
  if (segments.length === 0 && text) segments.push({ startSec: 0, endSec: json.duration ?? 0, text });
  return { language: normalizeLanguage(json.language) ?? fallbackLanguage ?? 'und', segments };
}

export async function transcribeWith(ep: Endpoint, input: AudioInput, opts: SttOptions, ctx: Ctx): Promise<SttResult> {
  const audio = await toBytes(input, ep, ctx);
  if (ep.maxBytes && audio.data.byteLength > ep.maxBytes) {
    throw new Vid2ContextError('too-large', `Audio is ${audio.data.byteLength} bytes; ${ep.label} accepts up to ${ep.maxBytes}.`);
  }
  const form = new FormData();
  form.append('file', new Blob([audio.data.slice()], { type: audio.mimeType }), uploadFilename(audio.filename, audio.mimeType));
  form.append('model', ep.model);
  form.append('response_format', 'verbose_json');
  const language = opts.language?.split(/[-_]/)[0]?.toLowerCase();
  if (language) form.append('language', language);
  if (opts.prompt) form.append('prompt', opts.prompt);

  const res = await fetchWithTimeout(
    ctx,
    `${ep.baseUrl}/audio/transcriptions`,
    { method: 'POST', headers: ep.key ? { authorization: `Bearer ${ep.key}` } : {}, body: form },
    ep.timeoutMs ?? 600_000,
  );
  if (!res.ok) throw await errorFromResponse(res, `${ep.label} transcription`);
  const parsed = parseVerboseJson((await res.json()) as VerboseJson, opts.language);
  return { ...parsed, model: ep.model };
}
