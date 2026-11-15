/**
 * importTranscript: a transcript from somewhere other than the platform (text
 * the user pasted, a subtitle file, or segments the browser extension read
 * from YouTube with the user's own IP address) becomes a normal VideoContext.
 * docs/contracts/transcript-import.md is the contract.
 *
 * Runtime-neutral: the server runs it behind POST /imports, and the web app
 * runs it in the browser when there is no API.
 */
import {
  type Attempt,
  type Ctx,
  decodeEntities,
  enforceInputPolicy,
  type Registry,
  type Segment,
  type Storage,
  Vid2ContextError,
  type VideoContext,
  type VideoMetadata,
} from '@vid2context/core';
import {
  ACCEPTED_FORMATS,
  baseName,
  type ImportFormat,
  isLanguageTag,
  MAX_SEGMENTS,
  normalizeSegments,
  parseTranscriptText,
  type RawSegment,
} from './parse.ts';

export type ImportVia = 'paste' | 'file' | 'browser';
export type CaptionKind = 'creator-captions' | 'auto-captions';

export interface ImportRequest {
  /** The video the transcript belongs to: any input the registry resolves to a single video. */
  url: string;
  /** Exactly one of text or segments. */
  text?: string;
  segments?: RawSegment[];
  /** BCP 47. Falls back to a language in the text (WebVTT `Language:`), then the filename (`talk.en.srt`), then the video's spoken language, then `und`. */
  language?: string;
  /** Helps format detection; only the base name is kept, and it is never stored. */
  filename?: string;
  /** Where the transcript came from. Default `paste` for text, `browser` for segments. */
  via?: ImportVia;
  /** For via=browser: the kind of YouTube track the extension read. Recorded, not trusted. */
  captionKind?: CaptionKind;
  /** What the extension knew about the video. Only fills gaps when the source gives no metadata; not trusted over it. */
  metadata?: KnownMetadata;
}

export interface ImportResponse {
  context: VideoContext;
  /** The detected text format, or 'segments'. */
  format: ImportFormat;
  /** True when the context was written to storage. */
  saved: boolean;
}

/** Metadata known from elsewhere, such as the extension's result. Fills gaps in what the source returns. */
export interface KnownMetadata {
  title?: string;
  channel?: string;
  durationSec?: number;
}

export interface ImportOptions {
  /** Where to save the context. Omitted or null: not saved. */
  storage?: Storage | null;
  /** Hosted mode (VID2CONTEXT_HOSTED=1): storage is shared and an import is not verified, so it is never saved. */
  hosted?: boolean;
  metadata?: KnownMetadata;
  /**
   * Default true. False skips `source.getMetadata`, for the browser without
   * an API, where the platform cannot be reached (CORS); `metadata` and the
   * url are used instead.
   */
  fetchMetadata?: boolean;
}

/** The largest `text` accepted, in characters (the route caps the body at 5 MB too). */
export const MAX_TEXT_CHARS = 5 * 1024 * 1024;

const VIAS: ImportVia[] = ['paste', 'file', 'browser'];
const KINDS: CaptionKind[] = ['creator-captions', 'auto-captions'];

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

const NOTHING_HINT = `Send the transcript as ${ACCEPTED_FORMATS}.`;
const SHAPE_HINT =
  'Send {"url": "<video URL>", "text": "<transcript>"} or {"url": "<video URL>", "segments": [{"startSec": 0, "text": "..."}]}.';

function optionalString(b: Record<string, unknown>, key: string, hint: string): string | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad(`${key} must be a string.`, hint);
  return v;
}

function checkSegments(v: unknown): RawSegment[] {
  if (!Array.isArray(v)) throw bad('segments must be an array.', SHAPE_HINT);
  if (v.length === 0) throw bad('segments is empty.', 'Send at least one segment with a startSec and text.');
  if (v.length > MAX_SEGMENTS) {
    throw new Vid2ContextError('too-large', `${v.length} segments; the limit is ${MAX_SEGMENTS}.`, {
      hint: 'Merge short segments, or import the transcript in parts for separate videos.',
    });
  }
  return v.map((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad(`segments[${i}] must be an object.`, SHAPE_HINT);
    const seg = s as Record<string, unknown>;
    if (typeof seg.startSec !== 'number' || !Number.isFinite(seg.startSec) || seg.startSec < 0) {
      throw bad(`segments[${i}].startSec must be a finite number of seconds, 0 or more.`, SHAPE_HINT);
    }
    if (seg.endSec !== undefined && seg.endSec !== null && (typeof seg.endSec !== 'number' || !Number.isFinite(seg.endSec))) {
      throw bad(`segments[${i}].endSec must be a finite number of seconds, or left out.`, SHAPE_HINT);
    }
    if (typeof seg.text !== 'string') throw bad(`segments[${i}].text must be a string.`, SHAPE_HINT);
    const text = decodeEntities(seg.text).replace(/\s+/g, ' ').trim();
    if (!text) throw bad(`segments[${i}].text is empty.`, 'Every segment needs some text; leave out the empty ones.');
    return { startSec: seg.startSec, ...(typeof seg.endSec === 'number' ? { endSec: seg.endSec } : {}), text };
  });
}

/** Check an import body (parsed JSON) and return it typed. Throws bad-request or too-large with a hint. */
export function validateImportRequest(body: unknown): ImportRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The body must be a JSON object.', SHAPE_HINT);
  const b = body as Record<string, unknown>;
  if (typeof b.url !== 'string' || !b.url.trim()) throw bad('url must be a non-empty string.', SHAPE_HINT);
  const hasText = b.text !== undefined && b.text !== null;
  const hasSegments = b.segments !== undefined && b.segments !== null;
  if (hasText === hasSegments) {
    throw bad(hasText ? 'Send text or segments, not both.' : 'Send the transcript as text or segments.', SHAPE_HINT);
  }
  const out: ImportRequest = { url: b.url.trim() };
  if (hasText) {
    if (typeof b.text !== 'string') throw bad('text must be a string.', SHAPE_HINT);
    if (!b.text.trim()) throw bad('text is empty.', NOTHING_HINT);
    if (b.text.length > MAX_TEXT_CHARS) {
      throw new Vid2ContextError('too-large', `The text is ${b.text.length} characters; the limit is ${MAX_TEXT_CHARS}.`, {
        hint: 'Import a shorter transcript, or split it.',
      });
    }
    out.text = b.text;
  } else {
    out.segments = checkSegments(b.segments);
  }
  const language = optionalString(b, 'language', 'Send a BCP 47 code such as "en" or "pt-BR".')?.trim();
  if (language) {
    if (!isLanguageTag(language))
      throw bad(`"${language.slice(0, 40)}" is not a language code.`, 'Send a BCP 47 code such as "en" or "pt-BR".');
    out.language = language;
  }
  const filename = optionalString(b, 'filename', 'Send the file name, such as "talk.en.srt".');
  if (filename) out.filename = baseName(filename).slice(0, 255);
  const via = optionalString(b, 'via', `Send one of ${VIAS.join(', ')}.`);
  if (via !== undefined) {
    if (!VIAS.includes(via as ImportVia)) throw bad(`via must be one of ${VIAS.join(', ')}.`, 'Leave via out for the default.');
    out.via = via as ImportVia;
  }
  const kind = optionalString(b, 'captionKind', `Send one of ${KINDS.join(', ')}.`);
  if (kind !== undefined) {
    if (!KINDS.includes(kind as CaptionKind))
      throw bad(`captionKind must be one of ${KINDS.join(', ')}.`, 'Leave captionKind out when unknown.');
    out.captionKind = kind as CaptionKind;
  }
  if (b.metadata !== undefined && b.metadata !== null) out.metadata = checkMetadata(b.metadata);
  return out;
}

function checkMetadata(v: unknown): KnownMetadata {
  const hint = 'Send metadata as {"title": "...", "channel": "...", "durationSec": 19}, or leave it out.';
  if (typeof v !== 'object' || Array.isArray(v) || v === null) throw bad('metadata must be an object.', hint);
  const m = v as Record<string, unknown>;
  const out: KnownMetadata = {};
  for (const key of ['title', 'channel'] as const) {
    const s = m[key];
    if (s === undefined || s === null) continue;
    if (typeof s !== 'string') throw bad(`metadata.${key} must be a string.`, hint);
    if (s.trim()) out[key] = s.trim().slice(0, 500);
  }
  if (m.durationSec !== undefined && m.durationSec !== null) {
    if (typeof m.durationSec !== 'number' || !Number.isFinite(m.durationSec) || m.durationSec <= 0) {
      throw bad('metadata.durationSec must be a positive number of seconds.', hint);
    }
    out.durationSec = m.durationSec;
  }
  return out;
}

function errInfo(err: unknown): { reason: string; detail: string } {
  if (err instanceof Vid2ContextError) return { reason: err.code, detail: err.message.slice(0, 300) };
  return { reason: 'error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
}

function withKnown(metadata: VideoMetadata, known: KnownMetadata | undefined): VideoMetadata {
  if (!known) return metadata;
  const out = { ...metadata };
  if (known.title?.trim() && out.title === (metadata.ref.url ?? metadata.ref.input)) out.title = known.title.trim();
  if (known.channel?.trim() && !out.channel) out.channel = { name: known.channel.trim() };
  if (
    out.durationSec === undefined &&
    known.durationSec !== undefined &&
    Number.isFinite(known.durationSec) &&
    known.durationSec > 0
  ) {
    out.durationSec = known.durationSec;
  }
  return out;
}

/**
 * Turn an import request into a VideoContext with origin 'imported'. The
 * request is validated here too (validateImportRequest), so the browser and
 * the route share the same rules.
 */
export async function importTranscript(
  registry: Registry,
  request: ImportRequest,
  opts: ImportOptions,
  ctx: Ctx,
): Promise<ImportResponse> {
  const req = validateImportRequest(request);
  await enforceInputPolicy(req.url, ctx);
  const { source, ref } = registry.resolve(req.url);
  if (ref.kind !== 'video') {
    throw new Vid2ContextError('unsupported-input', `"${req.url.slice(0, 200)}" is a ${ref.kind}, not a single video.`, {
      hint: 'Import a transcript for one video at a time: pass that video URL.',
    });
  }

  // Parse before any network call, so unreadable text fails fast.
  let parsed = req.text !== undefined ? parseTranscriptText(req.text, { filename: req.filename }) : undefined;
  const format: ImportFormat = parsed?.format ?? 'segments';
  if (parsed && parsed.segments.length === 0) {
    throw bad(
      format === 'plain' ? 'No transcript text was found.' : `Nothing could be read from this ${format} text.`,
      NOTHING_HINT,
    );
  }
  if (parsed && parsed.segments.length > MAX_SEGMENTS) {
    throw new Vid2ContextError('too-large', `${parsed.segments.length} segments; the limit is ${MAX_SEGMENTS}.`, {
      hint: 'Import a shorter transcript, or split it.',
    });
  }

  const attempts: Attempt[] = [];
  let metadata: VideoMetadata = { ref, title: ref.url ?? ref.input, chapters: [] };
  if (opts.fetchMetadata === false) {
    attempts.push({ id: source.id, stage: 'metadata', outcome: 'skipped', reason: 'no-api' });
  } else {
    const started = Date.now();
    try {
      metadata = await source.getMetadata(ref, ctx);
      attempts.push({ id: source.id, stage: 'metadata', outcome: 'ok', ms: Date.now() - started });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      attempts.push({ id: source.id, stage: 'metadata', outcome: 'error', ...errInfo(err), ms: Date.now() - started });
      ctx.log.warn('import: metadata failed, using minimal metadata', { ref: ref.id, ...errInfo(err) });
    }
  }
  metadata = withKnown(metadata, { ...req.metadata, ...opts.metadata });

  // Plain text and the panel copy have no end for their last segment: the video's duration gives it.
  if (
    req.text !== undefined &&
    parsed &&
    metadata.durationSec !== undefined &&
    (format === 'plain' || format === 'youtube-transcript')
  ) {
    parsed = parseTranscriptText(req.text, { filename: req.filename, durationSec: metadata.durationSec });
  }
  const segments: Segment[] = parsed ? parsed.segments : normalizeSegments(req.segments ?? [], metadata.durationSec);

  const via: ImportVia = req.via ?? (req.text !== undefined ? 'paste' : 'browser');
  attempts.push({
    id: 'import',
    stage: 'captions',
    outcome: 'ok',
    detail: [via, format, req.captionKind].filter(Boolean).join(', '),
  });
  const context: VideoContext = {
    metadata,
    transcript: {
      ref,
      language: req.language ?? parsed?.language ?? metadata.language ?? 'und',
      origin: 'imported',
      producer: `import/${via}`,
      segments,
      createdAt: new Date().toISOString(),
    },
    attempts,
  };

  let saved = false;
  if (opts.storage && !opts.hosted) {
    await opts.storage.putContext(context);
    saved = true;
  }
  return { context, format, saved };
}
