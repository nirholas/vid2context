/**
 * `vtt`: WebVTT captions for the HTML `<track>` element. A NOTE block names
 * the source and how the transcript was produced; cue text is escaped and
 * carries `<v Speaker>` voice tags when segments have speakers. With a
 * secondary transcript, its text follows on its own line(s) in each cue.
 */

import { buildCues, cueOptions, cueTime } from './cues.ts';
import type { Formatter } from './index.ts';
import { cleanText, describeOrigin } from './paragraphs.ts';

const escapeCue = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** NOTE text may not contain "-->" and must not contain a blank line. */
const noteSafe = (s: string): string => cleanText(s).replace(/-->/g, '->');

export const vtt: Formatter = {
  id: 'vtt',
  description: 'WebVTT (.vtt) captions for the HTML <track> element, with speaker voice tags when known.',
  mimeType: 'text/vtt; charset=utf-8',
  extension: 'vtt',
  timed: 'always',
  bilingual: true,
  render(context, opts = {}) {
    const { metadata: m, transcript: t } = context;
    const sec = opts.secondary;
    const note = [
      'NOTE',
      `${noteSafe(m.title)}`,
      `Source: ${noteSafe(m.ref.url ?? m.ref.input)}`,
      `Transcript: ${noteSafe(describeOrigin(t))}${t.translated ? ', machine-translated' : ''}`,
      ...(sec
        ? [
            `Second language (${noteSafe(sec.language)}): ${noteSafe(describeOrigin(sec))}${sec.translated ? ', machine-translated' : ''}`,
          ]
        : []),
    ].join('\n');
    const cues = buildCues(t.segments, false, cueOptions(opts)).map((c) => {
      const voice = c.speaker ? `<v ${escapeCue(cleanText(c.speaker))}>` : '';
      const text = [...c.lines.map((l, i) => (i === 0 ? voice : '') + escapeCue(l)), ...(c.secondary ?? []).map(escapeCue)].join(
        '\n',
      );
      return `${cueTime(c.startMs, '.')} --> ${cueTime(c.endMs, '.')}\n${text}`;
    });
    return `${['WEBVTT', note, ...cues].join('\n\n')}\n`;
  },
};
