/**
 * `lrc`: LRC timed lyrics, for music players and karaoke apps. Header tags
 * `[ti:]` (title), `[ar:]` (channel) and `[length:]` (when the duration is
 * known), then one `[mm:ss.xx]text` line per cue, its lines joined by a
 * space. LRC has no end times, so a gap of 1 s or more before the next cue
 * gets an empty timed line that clears the text. Speakers are written as
 * `Name: ` at each turn. LRC has no convention for two languages that every
 * player reads, so the secondary transcript is not shown.
 */

import { buildCues, cueOptions } from './cues.ts';
import type { Formatter } from './index.ts';
import { cleanText } from './paragraphs.ts';

const CLEAR_GAP_MS = 1000;

/** 83.456 s -> "01:23.46"; minutes keep counting past 59 ("75:00.00"). */
export function lrcTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(m)}:${p(s)}.${p(cs % 100)}`;
}

/** A header tag value: one line, no brackets that would end the tag. */
const tagValue = (s: string): string => cleanText(s).replace(/\[/g, '(').replace(/\]/g, ')');

export const lrc: Formatter = {
  id: 'lrc',
  description: 'LRC (.lrc) timed lyrics, one [mm:ss.xx] line per cue, for music players and karaoke apps.',
  mimeType: 'text/plain; charset=utf-8',
  extension: 'lrc',
  timed: 'always',
  render(context, opts = {}) {
    const { metadata: m } = context;
    const header = [`[ti:${tagValue(m.title)}]`];
    if (m.channel?.name) header.push(`[ar:${tagValue(m.channel.name)}]`);
    if (m.durationSec !== undefined && m.durationSec > 0) {
      const sec = Math.round(m.durationSec);
      header.push(`[length:${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}]`);
    }
    const lines: string[] = [];
    const { secondary: _ignored, ...layout } = cueOptions(opts);
    const cues = buildCues(context.transcript.segments, true, layout);
    cues.forEach((c, i) => {
      lines.push(`[${lrcTime(c.startMs)}]${c.lines.join(' ')}`);
      const next = cues[i + 1];
      if (!next || next.startMs - c.endMs >= CLEAR_GAP_MS) lines.push(`[${lrcTime(c.endMs)}]`);
    });
    return `${[...header, ...lines].join('\n')}\n`;
  },
};
