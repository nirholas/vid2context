/**
 * `ass`: Advanced SubStation Alpha (v4.00+) subtitles, for mpv, VLC, ffmpeg
 * burn-in and Aegisub. A 1920x1080 script with one readable Default style
 * (white sans serif, black outline and shadow, bottom center) and a smaller
 * pale yellow Secondary style for the second language of bilingual
 * subtitles. Each cue is one Dialogue line: `\N` breaks the lines, the
 * speaker goes in the Name field, and the secondary text follows after
 * `{\rSecondary}` in the same event so it always sits under the primary text.
 *
 * Escaping: `{` and `}` would open and close override blocks, so they are
 * written `\{` and `\}` (libass, used by mpv, VLC and ffmpeg). A backslash
 * gets a word joiner (U+2060) after it, so text such as `\N` stays literal.
 */

import { buildCues, cueOptions } from './cues.ts';
import type { Formatter } from './index.ts';
import { cleanText, describeOrigin } from './paragraphs.ts';

/** 3723.456 s -> "1:02:03.46" (H:MM:SS.cc). */
export function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${h}:${p(m)}:${p(s)}.${p(cs % 100)}`;
}

/** Text safe inside a Dialogue Text field: no override blocks, no escapes, no line breaks. */
export function escapeAss(text: string): string {
  return text
    .replace(/\\/g, '\\\u2060')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/[\r\n]+/g, ' ');
}

/** A header or Name field value: one line, and no commas in fields that commas delimit. */
const field = (s: string): string => cleanText(s).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
const headerValue = (s: string): string => cleanText(s);

const STYLE_FORMAT =
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
// Colours are &HAABBGGRR. Alignment 2 is bottom center; BorderStyle 1 is outline plus drop shadow.
const DEFAULT_STYLE =
  'Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3.5,1.5,2,120,120,60,1';
const SECONDARY_STYLE =
  'Style: Secondary,Arial,50,&H0099EEFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1.5,2,120,120,60,1';

export const ass: Formatter = {
  id: 'ass',
  description:
    'Advanced SubStation Alpha (.ass) subtitles with a readable default style, for mpv, VLC, ffmpeg burn-in and Aegisub. Bilingual subtitles show the second language in a smaller style.',
  mimeType: 'text/x-ssa; charset=utf-8',
  extension: 'ass',
  timed: 'always',
  bilingual: true,
  render(context, opts = {}) {
    const { metadata: m, transcript: t } = context;
    const sec = opts.secondary;
    const info = [
      '[Script Info]',
      `; ${headerValue(m.ref.url ?? m.ref.input)}`,
      `; Transcript: ${headerValue(describeOrigin(t))}${t.translated ? ', machine-translated' : ''}`,
      ...(sec ? [`; Second language (${headerValue(sec.language)}): ${headerValue(describeOrigin(sec))}`] : []),
      `Title: ${headerValue(m.title)}`,
      'ScriptType: v4.00+',
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      'PlayResX: 1920',
      'PlayResY: 1080',
      `Language: ${headerValue(t.language)}`,
    ];
    const styles = ['[V4+ Styles]', STYLE_FORMAT, DEFAULT_STYLE, SECONDARY_STYLE];
    const events = ['[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
    let lastEndCs = 0;
    for (const c of buildCues(t.segments, false, cueOptions(opts))) {
      // Centisecond rounding is monotonic, so cues stay in order; keep each at least 1 cs long.
      const startCs = Math.max(Math.round(c.startMs / 10), lastEndCs);
      const endCs = Math.max(Math.round(c.endMs / 10), startCs + 1);
      lastEndCs = endCs;
      const primary = c.lines.map(escapeAss).join('\\N');
      const second = c.secondary?.length ? `\\N{\\rSecondary}${c.secondary.map(escapeAss).join('\\N')}` : '';
      const name = c.speaker ? field(c.speaker) : '';
      events.push(`Dialogue: 0,${assTime(startCs * 10)},${assTime(endCs * 10)},Default,${name},0,0,0,,${primary}${second}`);
    }
    return `${[info.join('\n'), styles.join('\n'), events.join('\n')].join('\n\n')}\n`;
  },
};
