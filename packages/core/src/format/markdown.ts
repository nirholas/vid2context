/**
 * `markdown`: a readable transcript document. Title block and metadata, a
 * bounded description excerpt, chapters as `##` headings, and paragraphs that
 * start with a timestamp link into the video.
 */
import { formatTimestamp } from '../segments.ts';
import type { VideoContext } from '../types.ts';
import type { FormatOptions, Formatter } from './index.ts';
import {
  commentLines,
  escapeMd,
  excerpt,
  groupParagraphs,
  metadataLines,
  type Paragraph,
  quote,
  stamp,
  usesHours,
  visualLines,
} from './paragraphs.ts';

const DESCRIPTION_CHARS = 600;

/** One paragraph line: `[m:ss](link) **Speaker:** text`. */
export function paragraphLine(context: VideoContext, p: Paragraph, link: boolean): string {
  const ts = stamp(context.metadata.ref, p.startSec, usesHours(context), link);
  const who = p.speaker ? `**${escapeMd(p.speaker)}:** ` : '';
  return `${ts} ${who}${escapeMd(p.text)}`;
}

export function renderMarkdown(context: VideoContext, opts: FormatOptions): string {
  const { metadata: m } = context;
  const link = opts.linkTimestamps !== false;
  const hours = usesHours(context);
  const chapters = [...m.chapters].sort((a, b) => a.startSec - b.startSec);
  const blocks: string[] = [`# ${escapeMd(m.title)}`, metadataLines(context).join('\n')];

  if (m.description?.trim()) {
    const d = excerpt(m.description, DESCRIPTION_CHARS);
    const note = d.cut
      ? `\n\n_Description shortened to ${d.text.length} of ${m.description.trim().length} characters. The full text is in the json format._`
      : '';
    blocks.push(`## Description\n\n${quote(d.text)}${note}`);
  }

  const paras = groupParagraphs(context.transcript.segments, chapters);
  let section = -2;
  for (const p of paras) {
    if (p.chapter !== section) {
      section = p.chapter;
      const ch = chapters[p.chapter];
      blocks.push(ch ? `## ${escapeMd(ch.title)} (${formatTimestamp(ch.startSec, hours)})` : '## Transcript');
    }
    blocks.push(paragraphLine(context, p, link));
  }
  if (!paras.length) blocks.push('## Transcript\n\n_The transcript is empty._');

  if (opts.includeVisual && context.visual?.length) blocks.push(`## On screen\n\n${visualLines(context, link).join('\n')}`);
  if (opts.includeComments && context.comments?.length) blocks.push(`## Comments\n\n${commentLines(context.comments).join('\n')}`);

  return `${blocks.join('\n\n')}\n`;
}

export const markdown: Formatter = {
  id: 'markdown',
  description:
    'Markdown transcript: title and metadata, chapters as headings, paragraphs prefixed with timestamp links. Options: linkTimestamps, includeComments, includeVisual.',
  mimeType: 'text/markdown; charset=utf-8',
  extension: 'md',
  render: renderMarkdown,
};
