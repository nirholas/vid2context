/**
 * Turn transcript text into timed segments. The format is detected from the
 * content (a filename only breaks ties and hints at the language):
 *
 *   vtt                 "WEBVTT" header (parsed with parseVtt from provider-youtube)
 *   srv3, srv1, json3   YouTube timedtext bodies (parseSrv3, parseSrv1, parseJson3)
 *   srt                 cues timed "00:00:01,000 --> 00:00:04,000"
 *   youtube-transcript  the text copied from YouTube's "Show transcript" panel:
 *                       timestamp lines ("0:00", "1:02:03") alone or at the start
 *                       of a line, with the spoken-length labels some layouts add
 *                       ("2 seconds", "1 minute, 5 seconds")
 *   plain               anything else: one segment per paragraph
 *
 * Runtime-neutral and never throws: unreadable input comes back with no
 * segments, and importTranscript turns that into a bad-request.
 */
import { decodeEntities, type Segment } from '@vid2context/core';
import { detectFormat, parseJson3, parseSrv1, parseSrv3, parseVtt } from '@vid2context/provider-youtube';

export type TextFormat = 'vtt' | 'srt' | 'youtube-transcript' | 'srv1' | 'srv3' | 'json3' | 'plain';
export type ImportFormat = TextFormat | 'segments';

/** The most segments one import may have. */
export const MAX_SEGMENTS = 50_000;

/** Shown when nothing could be read. */
export const ACCEPTED_FORMATS =
  'WebVTT (.vtt), SRT (.srt), YouTube timedtext (srv1, srv3 or json3), the text copied from the "Show transcript" panel on YouTube, or plain text';

/** A segment as it comes in: the end is optional and filled in by normalizeSegments. */
export interface RawSegment {
  startSec: number;
  endSec?: number;
  text: string;
}

export interface ParseOptions {
  /** Helps with ties and the language (`talk.en.srt`). Never decides the format alone. */
  filename?: string;
  /** The video's duration, for the end of the last segment and of plain-text paragraphs. */
  durationSec?: number;
}

export interface ParsedTranscript {
  segments: Segment[];
  format: TextFormat;
  /** From a WebVTT `Language:` header, else from a language tag in the filename. */
  language?: string;
}

/** Strip a BOM and turn CRLF and lone CR line ends into LF. */
export function normalizeNewlines(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Collapse whitespace (line breaks inside a cue become spaces) and trim. */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Cue text from SRT: markup tags (<i>, <font>), ASS overrides ({\an8}) and entities. */
function cueText(s: string): string {
  return squash(decodeEntities(s.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '')));
}

/** "1:02:03,450", "02:03.450" or "2:03" to seconds; NaN when malformed. */
export function clockToSec(s: string): number {
  const parts = s.trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) return Number.NaN;
  let sec = 0;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return Number.NaN;
    sec = sec * 60 + Number(p);
  }
  return sec;
}

/**
 * Sort by start and fill in missing ends: the next segment's start, and for
 * the last one the duration (when it is later) or start + 5 s. Text is
 * trimmed; segments must already be valid (see importTranscript).
 */
export function normalizeSegments(raw: RawSegment[], durationSec?: number): Segment[] {
  const sorted = raw
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.startSec - b.s.startSec || a.i - b.i)
    .map(({ s }) => s);
  return sorted.map((s, i) => {
    const next = sorted[i + 1];
    const given = s.endSec !== undefined && Number.isFinite(s.endSec) && s.endSec >= s.startSec ? s.endSec : undefined;
    const fallback = next
      ? next.startSec
      : durationSec !== undefined && Number.isFinite(durationSec) && durationSec > s.startSec
        ? durationSec
        : s.startSec + 5;
    return { startSec: s.startSec, endSec: given ?? fallback, text: s.text.trim() };
  });
}

// ---------------------------------------------------------------- language

const LANG_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

/** True for something shaped like a BCP 47 tag ("en", "pt-BR", "zh-Hans"). */
export function isLanguageTag(s: string): boolean {
  return LANG_TAG.test(s);
}

/** "talk.en.srt" -> "en", "talk.pt-BR.vtt" -> "pt-BR". Two-letter primary tags only, so "notes.the.txt" is not a language. */
export function languageFromFilename(filename: string | undefined): string | undefined {
  const name = baseName(filename ?? '');
  const m = /\.([a-z]{2}(?:[-_][a-z0-9]{2,8})?)\.[a-z0-9]{2,5}$/i.exec(name);
  return m?.[1] ? m[1].replace('_', '-') : undefined;
}

/** The last path segment, so a client's directory never reaches a transcript. */
export function baseName(filename: string): string {
  return filename.split(/[/\\]/).pop() ?? '';
}

function vttLanguage(body: string): string | undefined {
  const header = body.split(/\n\s*\n/, 1)[0] ?? '';
  const lang = /^Language:\s*(\S+)\s*$/im.exec(header)?.[1];
  return lang && isLanguageTag(lang) ? lang : undefined;
}

// ---------------------------------------------------------------- SRT

const CLOCK = '(?:\\d+:)?\\d{1,2}:\\d{2}(?:[.,]\\d{1,3})?';
const TIMING = new RegExp(`^\\s*(${CLOCK})\\s*-->\\s*(${CLOCK})`);
const HAS_TIMING = new RegExp(`^\\s*${CLOCK}\\s*-->\\s*${CLOCK}`, 'm');

/** SRT, and timed cues without a WEBVTT header. A cue's number line is dropped; blank lines inside a cue are kept as text. */
export function parseSrt(body: string): RawSegment[] {
  const lines = normalizeNewlines(body).split('\n');
  const cues: { startSec: number; endSec: number; lines: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = TIMING.exec(line);
    if (!m) {
      cues.at(-1)?.lines.push(line);
      continue;
    }
    // The line before a timing line is the next cue's number, not the previous cue's text.
    const prev = cues.at(-1);
    if (prev && /^\s*\d+\s*$/.test(lines[i - 1] ?? '')) prev.lines.pop();
    cues.push({ startSec: clockToSec(m[1] ?? ''), endSec: clockToSec(m[2] ?? ''), lines: [] });
  }
  const out: RawSegment[] = [];
  for (const c of cues) {
    const text = cueText(c.lines.filter((l) => l.trim()).join(' '));
    if (!text || !Number.isFinite(c.startSec)) continue;
    out.push({ startSec: c.startSec, ...(Number.isFinite(c.endSec) ? { endSec: c.endSec } : {}), text });
  }
  return out;
}

// ---------------------------------------------------------------- YouTube "Show transcript"

/**
 * A timestamp at the start of a line: alone ("0:00"), before text ("0:00 hello"),
 * or run together with its spoken-length label, as the 2026 panel copies
 * ("0:011 secondAll right"). A digit may follow directly, a letter may not.
 */
const STAMP = /^((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|\s|\d)(.*)$/;
/** A spoken-length label on a line of its own: "2 seconds", "1 minute, 5 seconds", "1 hour, 2 minutes". */
const SPOKEN = /^\d+\s+(?:hours?|minutes?|seconds?)(?:,?\s+\d+\s+(?:hours?|minutes?|seconds?))*$/i;

/** The label the panel gives a timestamp (English UI): 0 -> "0 seconds", 62 -> "1 minute, 2 seconds", 3607 -> "1 hour, 7 seconds". */
export function spokenLabel(sec: number): string {
  const whole = Math.floor(sec);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const parts: string[] = [];
  if (h) parts.push(unit(h, 'hour'));
  if (m) parts.push(unit(m, 'minute'));
  if (s || parts.length === 0) parts.push(unit(s, 'second'));
  return parts.join(', ');
}

function stampLines(lines: string[]): number[] {
  return lines.flatMap((l) => {
    const m = STAMP.exec(l.trim());
    return m ? [clockToSec(m[1] ?? '')] : [];
  });
}

/** True when the text looks like a copy of the transcript panel: two or more timestamp lines, in order, or a single one on the first line. */
export function looksLikeYouTubeTranscript(body: string): boolean {
  const lines = normalizeNewlines(body)
    .split('\n')
    .filter((l) => l.trim());
  const stamps = stampLines(lines);
  if (stamps.length === 0) return false;
  if (stamps.length === 1) return STAMP.test((lines[0] ?? '').trim());
  let ordered = 0;
  for (let i = 1; i < stamps.length; i++) if ((stamps[i] ?? 0) >= (stamps[i - 1] ?? 0)) ordered++;
  return ordered / (stamps.length - 1) >= 0.9;
}

/**
 * The text copied from the "Show transcript" panel. Lines before the first
 * timestamp (a panel or chapter heading) are dropped. When a timestamp runs
 * together with its label, each segment is exactly one line, so the lines in
 * between are chapter headings ("Chapter 2: The cool thing") and are dropped
 * too. Otherwise the lines after a timestamp are its text, minus a spoken
 * label on the first of them.
 */
export function parseYouTubeTranscript(body: string): RawSegment[] {
  const out: { startSec: number; parts: string[]; oneLine: boolean; labelPending: boolean }[] = [];
  for (const raw of normalizeNewlines(body).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = STAMP.exec(line);
    if (m) {
      const startSec = clockToSec(m[1] ?? '');
      const label = spokenLabel(startSec);
      let rest = m[2] ?? '';
      const oneLine = rest.startsWith(label);
      if (oneLine) rest = rest.slice(label.length);
      rest = rest.trim();
      out.push({ startSec, parts: rest ? [rest] : [], oneLine, labelPending: !oneLine && !rest });
      continue;
    }
    const cur = out.at(-1);
    if (!cur || cur.oneLine) continue;
    if (cur.labelPending && (line === spokenLabel(cur.startSec) || SPOKEN.test(line))) {
      cur.labelPending = false;
      continue;
    }
    cur.labelPending = false;
    cur.parts.push(line);
  }
  return out
    .map((s) => ({ startSec: s.startSec, text: squash(decodeEntities(s.parts.join(' '))) }))
    .filter((s) => s.text && Number.isFinite(s.startSec));
}

// ---------------------------------------------------------------- plain

/** One segment per paragraph (blank-line separated), all starting at 0. */
export function parsePlain(body: string, durationSec?: number): RawSegment[] {
  return normalizeNewlines(body)
    .split(/\n[ \t]*\n/)
    .map((p) => squash(decodeEntities(p)))
    .filter(Boolean)
    .map((text) => ({ startSec: 0, ...(durationSec !== undefined && durationSec > 0 ? { endSec: durationSec } : {}), text }));
}

// ---------------------------------------------------------------- detect and parse

function extension(filename: string | undefined): string {
  return /\.([a-z0-9]+)$/i.exec(baseName(filename ?? ''))?.[1]?.toLowerCase() ?? '';
}

/** Detect the format of transcript text and parse it into sorted segments with every end filled in. */
export function parseTranscriptText(text: string, opts: ParseOptions = {}): ParsedTranscript {
  const body = normalizeNewlines(text).trim();
  const fileLang = languageFromFilename(opts.filename);
  const done = (format: TextFormat, raw: RawSegment[], language = fileLang): ParsedTranscript => ({
    segments: normalizeSegments(raw, opts.durationSec),
    format,
    ...(language ? { language } : {}),
  });
  if (!body) return done('plain', []);

  if (/^WEBVTT/.test(body)) return done('vtt', parseVtt(body), vttLanguage(body) ?? fileLang);

  // JSON and XML are YouTube timedtext or nothing: as plain text they would be markup, not a transcript.
  if (body.startsWith('{') || body.startsWith('[') || body.startsWith('<')) {
    const tt = detectFormat(body);
    if (tt === 'json3') return done('json3', parseJson3(body));
    if (tt === 'srv3') return done('srv3', parseSrv3(body));
    if (tt === 'srv1') return done('srv1', parseSrv1(body));
    return done(body.startsWith('<') ? 'srv3' : 'json3', []);
  }

  if (HAS_TIMING.test(body)) {
    // Timed cues without a WEBVTT header: SRT, or a .vtt file that lost its header.
    return done(extension(opts.filename) === 'vtt' ? 'vtt' : 'srt', parseSrt(body));
  }

  if (looksLikeYouTubeTranscript(body)) return done('youtube-transcript', parseYouTubeTranscript(body));

  return done('plain', parsePlain(body, opts.durationSec));
}
