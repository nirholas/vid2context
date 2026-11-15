/**
 * `sbv`: YouTube SubViewer captions, the format YouTube Studio exports and
 * imports. Each cue is a `H:MM:SS.mmm,H:MM:SS.mmm` line, its text lines and a
 * blank line. Speakers are written as `Name: ` at each turn. With a
 * secondary transcript, its lines follow the primary lines in each cue.
 */

import { buildCues, cueOptions } from './cues.ts';
import type { Formatter } from './index.ts';

/** 3723.456 s -> "1:02:03.456" (unpadded hours). */
export function sbvTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${h}:${p(m)}:${p(s)}.${p(t % 1000, 3)}`;
}

export const sbv: Formatter = {
  id: 'sbv',
  description: 'YouTube SubViewer (.sbv) captions, the format YouTube Studio imports and exports.',
  mimeType: 'text/plain; charset=utf-8',
  extension: 'sbv',
  timed: 'always',
  bilingual: true,
  render(context, opts = {}) {
    const blocks = buildCues(context.transcript.segments, true, cueOptions(opts)).map(
      (c) => `${sbvTime(c.startMs)},${sbvTime(c.endMs)}\n${[...c.lines, ...(c.secondary ?? [])].join('\n')}`,
    );
    return blocks.length ? `${blocks.join('\n\n')}\n` : '';
  },
};
