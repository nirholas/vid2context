/**
 * `vtt`: WebVTT captions for the HTML `<track>` element. A NOTE block names
 * the source and how the transcript was produced; cue text is escaped and
 * carries `<v Speaker>` voice tags when segments have speakers.
 */

import { buildCues, cueTime } from './cues.ts';
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
  render(context) {
    const { metadata: m, transcript: t } = context;
    const note = [
      'NOTE',
      `${noteSafe(m.title)}`,
      `Source: ${noteSafe(m.ref.url ?? m.ref.input)}`,
      `Transcript: ${noteSafe(describeOrigin(t))}${t.translated ? ', machine-translated' : ''}`,
    ].join('\n');
    const cues = buildCues(t.segments, false).map((c) => {
      const voice = c.speaker ? `<v ${escapeCue(cleanText(c.speaker))}>` : '';
      const text = c.lines.map((l, i) => (i === 0 ? voice : '') + escapeCue(l)).join('\n');
      return `${cueTime(c.startMs, '.')} --> ${cueTime(c.endMs, '.')}\n${text}`;
    });
    return `${['WEBVTT', note, ...cues].join('\n\n')}\n`;
  },
};
