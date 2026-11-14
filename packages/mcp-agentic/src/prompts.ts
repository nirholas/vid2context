/**
 * The exact instructions sent with each sampling call. The no-sampling chunk
 * plan returns these same texts, so an agent that does the work itself
 * follows the same rules the client's model would.
 */
import { formatTimestamp, type VideoContext } from '@vid2context/core';
import type { TranscriptChunk } from './chunking.ts';
import { needsHours, videoDuration } from './chunking.ts';

export const MAP_SYSTEM = [
  'You take notes on one part of a video transcript for a research digest.',
  'Each transcript line starts with a timestamp in square brackets, like [4:05].',
  'Rules:',
  '- Write 5 to 15 bullet points, each starting with "- ".',
  '- Each bullet states one claim, fact, number, recommendation or opinion from this part of the video.',
  '- End every bullet with the timestamp of the transcript line it comes from, copied exactly, for example [4:05].',
  '- Never invent a timestamp and never use one that is not in the transcript you were given.',
  '- Keep the specifics: names, years, model names, prices, numbers.',
  '- If a question is given, prefer what helps answer it, but still note the main points.',
  '- No introduction and no summary: only the bullets.',
].join('\n');

export const REDUCE_SYSTEM = [
  'You combine notes taken from one or more videos into one digest.',
  "Each source's notes are listed under its exact title. Every note ends with a [m:ss] timestamp in that video.",
  'Rules:',
  '- Cite every claim as [Exact source title @ m:ss], right after the claim, using only titles and timestamps that appear in the notes.',
  '- Do not write URLs; links are added for you.',
  '- If a question is given, start with "## Answer" and answer it directly, with citations. Say plainly when the sources do not answer it.',
  '- Then write a short overview and organise the rest by theme under "## " headings, as bullet points.',
  '- When there is more than one source, add "## Where sources agree" and "## Where sources disagree", citing each side. If they do not disagree on anything, say so.',
  '- Do not add facts that are not in the notes.',
].join('\n');

/** Default output budgets for the client's model, in tokens. */
export const MAP_MAX_TOKENS = 1500;
export const REDUCE_MAX_TOKENS = 3000;

/** Cheap and fast for the many map calls; more capable for the single reduce call. */
export const MAP_MODEL_PREFERENCES = { costPriority: 0.9, speedPriority: 0.8, intelligencePriority: 0.3 };
export const REDUCE_MODEL_PREFERENCES = { costPriority: 0.5, speedPriority: 0.4, intelligencePriority: 0.7 };

export function mapUserMessage(context: VideoContext, chunk: TranscriptChunk, question?: string): string {
  const m = context.metadata;
  const long = needsHours(context);
  const lines = [
    `Video: ${m.title}`,
    m.channel ? `Channel: ${m.channel.name}` : undefined,
    `Part ${chunk.index + 1} of ${chunk.of}: ${formatTimestamp(chunk.fromSec, long)} to ${formatTimestamp(chunk.toSec, long)} of ${formatTimestamp(videoDuration(context), long)}`,
    chunk.chapters.length > 0 ? `Chapters: ${chunk.chapters.join(' | ')}` : undefined,
    question ? `Question: ${question}` : undefined,
    '',
    'Transcript:',
    chunk.text,
  ];
  return lines.filter((l) => l !== undefined).join('\n');
}

export interface SourceNotes {
  context: VideoContext;
  notes: string;
}

export function reduceUserMessage(sources: SourceNotes[], question?: string): string {
  const parts = [question ? `Question: ${question}\n` : undefined, `Sources: ${sources.length}`];
  for (const s of sources) {
    const m = s.context.metadata;
    const meta = [m.channel?.name, `duration ${formatTimestamp(videoDuration(s.context), needsHours(s.context))}`]
      .filter(Boolean)
      .join(', ');
    parts.push(`\n### ${m.title}\n(${meta})\nNotes:\n${s.notes || '(no verified notes)'}`);
  }
  return parts.filter((p) => p !== undefined).join('\n');
}
