/**
 * Context for client-only mode, where the browser cannot fetch YouTube
 * captions (YouTube blocks cross-origin requests): a VideoContext JSON file
 * from vid2context (`--format json`, or context.json in a bundle), or a
 * transcript the user pastes with timestamps (YouTube's "Show transcript"
 * panel, SRT, WebVTT, or `[m:ss] text` lines).
 */
import { type Segment, Vid2ContextError, type VideoContext, type VideoRef } from '@vid2context/core';

function isVideoContext(v: unknown): v is VideoContext {
  const c = v as Partial<VideoContext> | null;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.metadata?.title === 'string' &&
    typeof c.metadata?.ref?.id === 'string' &&
    Array.isArray(c.transcript?.segments)
  );
}

/** One or more VideoContexts from a JSON file: a single context, an array, or `{ videos: [...] }` / `{ contexts: [...] }`. */
export function parseContextJson(text: string, filename = 'file'): VideoContext[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Vid2ContextError('bad-request', `${filename} is not valid JSON.`, {
      hint: 'Drop the .json file vid2context wrote (`--format json`, or context.json from a bundle).',
      cause: err,
    });
  }
  const list = Array.isArray(data)
    ? data
    : isVideoContext(data)
      ? [data]
      : ((data as { videos?: unknown[]; contexts?: unknown[] } | null)?.contexts ??
        (data as { videos?: unknown[] } | null)?.videos ??
        []);
  const contexts = list.filter(isVideoContext);
  if (contexts.length === 0) {
    throw new Vid2ContextError('bad-request', `${filename} does not contain a vid2context VideoContext.`, {
      hint: 'Use the JSON output of vid2context: it has metadata, transcript.segments and attempts.',
    });
  }
  return contexts.map((c) => ({ ...c, attempts: Array.isArray(c.attempts) ? c.attempts : [] }));
}

/** "1:02:03" -> 3723, "12:05" -> 725, "00:01:02,500" -> 62.5. */
export function parseClock(s: string): number | undefined {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return undefined;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return h * 3600 + min * 60 + sec + frac;
}

const CUE = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;
const BRACKETED = /^\s*[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*(?:[-:|]\s*)?(.*)$/;

/**
 * Timed segments from pasted text. Accepts SRT and WebVTT cues, lines that
 * start with a timestamp (`0:12 text`, `[0:12] text`), and YouTube's
 * transcript panel where the timestamp sits on its own line above the text.
 */
export function parseTranscriptText(text: string): Segment[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const raw: { start: number; end?: number; text: string }[] = [];
  let current: { start: number; end?: number; text: string } | null = null;
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line === 'WEBVTT' || /^\d+$/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) {
      continue;
    }
    const cue = CUE.exec(line);
    if (cue) {
      const start = parseClock(cue[1] ?? '');
      const end = parseClock(cue[2] ?? '');
      if (start !== undefined) {
        current = { start, ...(end !== undefined ? { end } : {}), text: '' };
        raw.push(current);
      }
      continue;
    }
    const stamped = BRACKETED.exec(line);
    const start = stamped ? parseClock(stamped[1] ?? '') : undefined;
    if (stamped && start !== undefined) {
      current = { start, text: (stamped[2] ?? '').trim() };
      raw.push(current);
      continue;
    }
    if (current) current.text = current.text ? `${current.text} ${line}` : line;
  }
  const cleaned = raw
    .map((r) => ({ ...r, text: r.text.replace(/<[^>]+>/g, '').trim() }))
    .filter((r) => r.text)
    .sort((a, b) => a.start - b.start);
  return cleaned.map((r, i) => {
    const next = cleaned[i + 1];
    const end = r.end ?? (next ? next.start : r.start + Math.max(2, Math.ceil(r.text.split(/\s+/).length / 2.5)));
    return { startSec: r.start, endSec: Math.max(end, r.start), text: r.text };
  });
}

const YT_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

/** A VideoRef for an optional source URL. YouTube URLs get a real youtube ref, so citations open the video. */
export function refFor(url: string | undefined, text: string): VideoRef {
  const yt = url ? YT_ID.exec(url) : null;
  if (yt?.[1]) {
    const id = yt[1];
    return {
      input: url ?? id,
      platform: 'youtube',
      kind: 'video',
      id: `youtube:${id}`,
      nativeId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  }
  const nativeId = hashText(`${url ?? ''}\n${text}`);
  if (url && /^https?:\/\//i.test(url))
    return { input: url, platform: 'web', kind: 'video', id: `pasted:${nativeId}`, nativeId, url };
  return { input: 'pasted transcript', platform: 'pasted', kind: 'video', id: `pasted:${nativeId}`, nativeId };
}

/** FNV-1a, enough for a stable local id; not a security hash. */
function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function contextFromPaste(input: { title: string; url?: string; text: string; language?: string }): VideoContext {
  const segments = parseTranscriptText(input.text);
  if (segments.length === 0) {
    throw new Vid2ContextError('bad-request', 'No timestamps found in the pasted text.', {
      hint: 'Paste a transcript with timestamps: YouTube "Show transcript", SRT, WebVTT or lines like "[1:05] text". Citations need them.',
    });
  }
  const ref = refFor(input.url?.trim() || undefined, input.text);
  const last = segments[segments.length - 1];
  return {
    metadata: {
      ref,
      title: input.title.trim() || 'Pasted transcript',
      chapters: [],
      ...(last ? { durationSec: Math.ceil(last.endSec) } : {}),
      ...(ref.platform === 'youtube' ? { thumbnailUrl: `https://i.ytimg.com/vi/${ref.nativeId}/mqdefault.jpg` } : {}),
    },
    transcript: {
      ref,
      language: input.language || 'und',
      origin: 'native-transcript',
      producer: 'pasted',
      segments,
      createdAt: new Date().toISOString(),
    },
    attempts: [],
  };
}
