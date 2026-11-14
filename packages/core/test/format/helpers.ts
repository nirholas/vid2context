/**
 * Strict SRT and WebVTT parsers for the format tests, plus fixture loading.
 * They throw on anything a strict player would reject, so a passing parse
 * means the file is well formed.
 */
import { readFileSync } from 'node:fs';
import { decodeEntities } from '../../src/segments.ts';
import type { Segment, VideoContext } from '../../src/types.ts';

const root = new URL('../../../../', import.meta.url);

export function loadContext(nativeId: string): VideoContext {
  return JSON.parse(readFileSync(new URL(`tests/fixtures/contexts/youtube-${nativeId}.json`, root), 'utf8'));
}

export function readRepoFile(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

export interface ParsedCue {
  index?: number;
  startMs: number;
  endMs: number;
  lines: string[];
  /** Voice from a `<v Name>` tag (VTT only). */
  voice?: string;
}

const ms = (h: string, m: string, s: string, f: string) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f);

export function parseSrt(src: string): ParsedCue[] {
  if (src.includes('\r')) throw new Error('SRT: carriage return found');
  if (!src.endsWith('\n') || src.endsWith('\n\n')) throw new Error('SRT: file must end with exactly one newline');
  const timing = /^(\d{2}):([0-5]\d):([0-5]\d),(\d{3}) --> (\d{2}):([0-5]\d):([0-5]\d),(\d{3})$/;
  return src
    .slice(0, -1)
    .split('\n\n')
    .map((block, i) => {
      const [num, time, ...lines] = block.split('\n');
      if (!/^\d+$/.test(num ?? '')) throw new Error(`SRT block ${i + 1}: bad cue number "${num}"`);
      const t = timing.exec(time ?? '');
      if (!t) throw new Error(`SRT block ${i + 1}: bad timing line "${time}"`);
      if (!lines.length || lines.some((l) => !l.trim())) throw new Error(`SRT block ${i + 1}: empty text line`);
      if (lines.some((l) => l.includes('-->'))) throw new Error(`SRT block ${i + 1}: "-->" in text`);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for control characters.
      if (lines.some((l) => /[\u0000-\u001f\u007f]/.test(l))) throw new Error(`SRT block ${i + 1}: control character`);
      const [, h1, m1, s1, f1, h2, m2, s2, f2] = t as unknown as string[];
      return {
        index: Number(num),
        startMs: ms(h1 as string, m1 as string, s1 as string, f1 as string),
        endMs: ms(h2 as string, m2 as string, s2 as string, f2 as string),
        lines,
      };
    });
}

/** Unescape VTT cue text; throws on a raw `&` or `<` that is not an entity or a voice tag. */
function vttText(line: string, where: string): { text: string; voice?: string } {
  let voice: string | undefined;
  const noTags = line.replace(/<v ([^>]+)>|<\/v>/g, (_m, name: string | undefined) => {
    if (name) voice = name;
    return '';
  });
  if (/[<>]/.test(noTags)) throw new Error(`${where}: raw "<" or ">" in cue text`);
  if (/&(?!amp;|lt;|gt;|nbsp;|lrm;|rlm;|#\d+;)/.test(noTags)) throw new Error(`${where}: raw "&" in cue text`);
  const text = noTags.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return voice === undefined ? { text } : { text, voice };
}

export function parseVtt(src: string): { notes: string[]; cues: ParsedCue[] } {
  if (src.includes('\r')) throw new Error('VTT: carriage return found');
  const blocks = src.replace(/\n+$/, '').split(/\n{2,}/);
  if (blocks[0] !== 'WEBVTT') throw new Error(`VTT: first block must be exactly "WEBVTT", got "${blocks[0]}"`);
  const timing = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3}) --> (\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})(?: .*)?$/;
  const notes: string[] = [];
  const cues: ParsedCue[] = [];
  blocks.slice(1).forEach((block, i) => {
    const where = `VTT block ${i + 2}`;
    if (/^NOTE($|[ \n])/.test(block)) {
      if (block.includes('-->')) throw new Error(`${where}: "-->" in NOTE`);
      notes.push(block);
      return;
    }
    const rows = block.split('\n');
    if (!(rows[0] ?? '').includes('-->')) rows.shift(); // cue identifier
    const t = timing.exec(rows[0] ?? '');
    if (!t) throw new Error(`${where}: bad timing line "${rows[0]}"`);
    const textRows = rows.slice(1);
    if (!textRows.length) throw new Error(`${where}: cue without text`);
    let voice: string | undefined;
    const lines = textRows.map((r) => {
      const p = vttText(r, where);
      voice ??= p.voice;
      return p.text;
    });
    const [, h1, m1, s1, f1, h2, m2, s2, f2] = t as unknown as string[];
    cues.push({
      startMs: ms(h1 as string, m1 as string, s1 as string, f1 as string),
      endMs: ms(h2 as string, m2 as string, s2 as string, f2 as string),
      lines,
      ...(voice !== undefined ? { voice } : {}),
    });
  });
  return { notes, cues };
}

/** The words of the source segments, decoded the way the formatters decode them. */
export function sourceWords(segments: Segment[]): string[] {
  return segments.flatMap((s) => {
    let t = s.text;
    for (let i = 0; i < 3; i++) t = decodeEntities(t);
    return t.split(/\s+/).filter(Boolean);
  });
}

/**
 * Assert every caption rule. Returns a list of problems (empty when valid),
 * so a failing test shows all of them.
 */
export function cueProblems(cues: ParsedCue[], segments: Segment[]): string[] {
  const problems: string[] = [];
  cues.forEach((c, i) => {
    const next = cues[i + 1];
    if (c.index !== undefined && c.index !== i + 1) problems.push(`cue ${i + 1}: numbered ${c.index}`);
    if (c.endMs <= c.startMs) problems.push(`cue ${i + 1}: zero or negative length`);
    if (next && c.endMs > next.startMs) problems.push(`cue ${i + 1}: overlaps the next cue`);
    // Shorter than 0.5 s is allowed only when the next cue starts within 0.5 s, so there was no room.
    if (c.endMs - c.startMs < 500 && !(next && next.startMs - c.startMs < 500)) {
      problems.push(`cue ${i + 1}: ${c.endMs - c.startMs} ms although there was room for 500`);
    }
    if (c.lines.length > 2) problems.push(`cue ${i + 1}: ${c.lines.length} lines`);
    for (const l of c.lines) if (l.length > 42) problems.push(`cue ${i + 1}: line of ${l.length} characters`);
  });
  const got = cues.flatMap((c) => c.lines.join(' ').split(/\s+/).filter(Boolean));
  const want = sourceWords(segments);
  if (got.join(' ') !== want.join(' ')) {
    const at = got.findIndex((w, i) => w !== want[i]);
    problems.push(`words differ from the source at word ${at}: got "${got[at]}", want "${want[at]}"`);
  }
  return problems;
}

/** GitHub-style anchor for a Markdown heading's text (escapes removed first). */
export function githubAnchor(heading: string): string {
  return heading
    .replace(/\\(.)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}
