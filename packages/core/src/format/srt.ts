/**
 * `srt`: SubRip captions. Numbered cues, `HH:MM:SS,mmm` timings, plain text
 * with control characters removed, at most 2 lines of 42 characters.
 */

import { buildCues, cueTime } from './cues.ts';
import type { Formatter } from './index.ts';

export const srt: Formatter = {
  id: 'srt',
  description: 'SubRip (.srt) captions: at most 2 lines of 42 characters per cue, no overlaps, for players and editors.',
  mimeType: 'application/x-subrip; charset=utf-8',
  extension: 'srt',
  render(context) {
    const cues = buildCues(context.transcript.segments, true);
    // "-->" inside text would read as a timing line to strict parsers.
    const blocks = cues.map(
      (c, i) =>
        `${i + 1}\n${cueTime(c.startMs, ',')} --> ${cueTime(c.endMs, ',')}\n${c.lines.map((l) => l.replace(/-->/g, '->')).join('\n')}`,
    );
    return blocks.length ? `${blocks.join('\n\n')}\n` : '';
  },
};
