/**
 * Helpers shared by the Markdown-based formatters (markdown, pack) and the
 * caption formatters (srt, vtt): text cleanup, paragraph grouping, timestamps
 * and the one-line description of how a transcript was produced.
 */
import { decodeEntities, formatTimestamp, timestampUrl } from '../segments.ts';
import type { Chapter, Segment, Transcript, VideoContext, VideoRef } from '../types.ts';

/** A pause this long (seconds) between segments ends a paragraph once it is long enough. */
const PAUSE_SEC = 1.5;
/** A paragraph may end on a sentence end or pause once it reaches either soft limit. */
const SOFT_SEC = 30;
const SOFT_WORDS = 120;
/** A paragraph always ends at either hard limit, even with no punctuation or pause (auto-captions). */
const HARD_SEC = 90;
const HARD_WORDS = 160;

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufeff\u200b]/g;

/**
 * Caption text ready to print: entities decoded until none are left (srv1
 * captions arrive double-encoded, as in `&amp;#39;`), control characters
 * removed, whitespace collapsed.
 */
export function cleanText(text: string): string {
  let s = text;
  for (let i = 0; i < 3; i++) {
    const next = decodeEntities(s);
    if (next === s) break;
    s = next;
  }
  return s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

export interface Paragraph {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
  /** Index of the chapter this paragraph belongs to, or -1 before the first chapter (or when there are none). */
  chapter: number;
}

function chapterAt(chapters: Chapter[], sec: number): number {
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    if (c && c.startSec <= sec + 0.001) idx = i;
  }
  return idx;
}

/**
 * Group segments into readable paragraphs. A paragraph never splits a
 * segment. It always ends at a speaker change or a chapter start. Otherwise
 * it ends on a sentence end or a pause of 1.5 s or more once it holds 30 s or
 * 120 words, and unconditionally at 90 s or 160 words.
 */
export function groupParagraphs(segments: Segment[], chapters: Chapter[] = []): Paragraph[] {
  const sortedChapters = [...chapters].sort((a, b) => a.startSec - b.startSec);
  const out: Paragraph[] = [];
  const segs = segments.filter((s) => cleanText(s.text));
  let parts: string[] = [];
  let words = 0;
  let startSec = 0;
  let endSec = 0;
  let speaker: string | undefined;
  let chapter = -1;
  const flush = () => {
    if (parts.length)
      out.push({ startSec, endSec, text: parts.join(' '), ...(speaker !== undefined ? { speaker } : {}), chapter });
    parts = [];
    words = 0;
  };
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as Segment;
    const text = cleanText(seg.text);
    const segChapter = chapterAt(sortedChapters, seg.startSec);
    if (parts.length && (seg.speaker !== speaker || segChapter !== chapter)) flush();
    if (!parts.length) {
      startSec = seg.startSec;
      endSec = seg.endSec;
      speaker = seg.speaker;
      chapter = segChapter;
    }
    parts.push(text);
    words += text.split(' ').length;
    endSec = Math.max(endSec, seg.endSec);

    const next = segs[i + 1];
    const dur = endSec - startSec;
    const soft = dur >= SOFT_SEC || words >= SOFT_WORDS;
    const hard = dur >= HARD_SEC || words >= HARD_WORDS;
    const pause = next ? next.startSec - seg.endSec >= PAUSE_SEC : false;
    if (hard || (soft && (SENTENCE_END.test(text) || pause))) flush();
  }
  flush();
  return out;
}

/** True when timestamps in this video's documents should use h:mm:ss. */
export function usesHours(context: VideoContext): boolean {
  return mediaEndSec(context) >= 3600;
}

/** The end of the media: the larger of the metadata duration and the last segment's end. */
export function mediaEndSec(context: VideoContext): number {
  const last = context.transcript.segments.reduce((m, s) => Math.max(m, s.endSec), 0);
  return Math.max(context.metadata.durationSec ?? 0, last);
}

/** `[m:ss](link)`, or plain `[m:ss]` when the platform has no deep link or links are off. */
export function stamp(ref: VideoRef, sec: number, hours: boolean, link = true): string {
  const label = formatTimestamp(sec, hours);
  const url = link ? timestampUrl(ref, sec) : undefined;
  return url ? `[${label}](${url})` : `[${label}]`;
}

/** "auto-captions from youtube-captions", "speech-to-text by stt/groq/whisper-large-v3-turbo", ... */
export function describeOrigin(t: Transcript): string {
  const by = t.model && !t.producer.includes(t.model) ? `${t.producer} (${t.model})` : t.producer;
  switch (t.origin) {
    case 'creator-captions':
      return `creator captions from ${by}`;
    case 'auto-captions':
      return `auto-captions from ${by}`;
    case 'native-transcript':
      return `published transcript from ${by}`;
    case 'stt':
      return `speech-to-text by ${by}`;
    case 'video-model':
      return `transcribed by video model ${by}`;
  }
}

/**
 * Escape what would turn caption or title text into Markdown structure:
 * backslashes, emphasis, code spans and inline HTML. Brackets are escaped too
 * when the text goes inside link text.
 */
export function escapeMd(text: string, inLink = false): string {
  const s = text.replace(/[\\`*<]/g, (c) => `\\${c}`);
  return inLink ? s.replace(/[[\]]/g, (c) => `\\${c}`) : s;
}

/** Cut `text` to at most `max` characters on a word boundary. `cut` tells whether anything was removed. */
export function excerpt(text: string, max: number): { text: string; cut: boolean } {
  const s = text.trim();
  if (s.length <= max) return { text: s, cut: false };
  const head = s.slice(0, max + 1);
  const space = head.search(/\s\S*$/);
  const cutAt = space > max * 0.5 ? space : max;
  return { text: s.slice(0, cutAt).trimEnd(), cut: true };
}

/** Description lines as a Markdown blockquote, so its own formatting cannot break the document. */
export function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l.trim() ? `> ${escapeMd(l.trimEnd())}` : '>'))
    .join('\n');
}

/** The metadata list shared by markdown and pack, one `- Key: value` line each. */
export function metadataLines(context: VideoContext): string[] {
  const { metadata: m, transcript: t } = context;
  const hours = usesHours(context);
  const lines: string[] = [];
  if (m.channel) {
    const name = escapeMd(m.channel.name, true);
    lines.push(`- Channel: ${m.channel.url ? `[${name}](${m.channel.url})` : name}`);
  }
  if (m.publishedAt) lines.push(`- Published: ${m.publishedAt.slice(0, 10)}`);
  const dur = m.durationSec ?? mediaEndSec(context);
  if (dur > 0) lines.push(`- Duration: ${formatTimestamp(dur, hours)}`);
  const url = m.ref.url ?? (/^https?:/i.test(m.ref.input) ? m.ref.input : undefined);
  lines.push(`- Source: ${url ?? m.ref.id}`);
  lines.push(`- Language: ${t.language}`);
  lines.push(`- Transcript: ${describeOrigin(t)}${t.translated ? ', machine-translated' : ''}`);
  return lines;
}

/** `**Author** (creator, pinned, 12 likes): text`, replies indented under their parent. */
export function commentLines(comments: VideoContext['comments'], depth = 0): string[] {
  const out: string[] = [];
  const pad = '  '.repeat(depth);
  for (const c of comments ?? []) {
    const flags = [c.isCreator ? 'creator' : '', c.isPinned ? 'pinned' : '', c.likes ? `${c.likes} likes` : ''].filter(Boolean);
    const body = c.text
      .trim()
      .split('\n')
      .map((l) => escapeMd(cleanText(l)))
      .filter(Boolean)
      .join(`\n${pad}  `);
    out.push(`${pad}- **${escapeMd(c.author)}**${flags.length ? ` (${flags.join(', ')})` : ''}: ${body}`);
    if (c.replies?.length) out.push(...commentLines(c.replies, depth + 1));
  }
  return out;
}

/** `- [m:ss](link) slide: text`, sorted by time. */
export function visualLines(context: VideoContext, link: boolean): string[] {
  const hours = usesHours(context);
  return [...(context.visual ?? [])]
    .sort((a, b) => a.atSec - b.atSec)
    .map((v) => `- ${stamp(context.metadata.ref, v.atSec, hours, link)} ${v.kind}: ${escapeMd(cleanText(v.text))}`);
}
