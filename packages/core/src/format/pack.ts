/**
 * `pack`: the context pack. One Markdown document for one or many videos,
 * written for the model that will read it (a Claude or ChatGPT Project file,
 * a custom GPT's knowledge, an agent's context). It says what it is, how to
 * cite, lists the videos, then gives each video's metadata, chapters and
 * timestamped transcript.
 *
 * With `maxTokens` it fits the budget (measured by estimateTokens) by
 * degrading in a fixed order, stopping as soon as it fits: drop comments,
 * drop visual notes, link fewer timestamps, shorten descriptions, then cut
 * each transcript in proportion to its length at paragraph boundaries. Every
 * cut leaves a marker saying what was left out and how to get it.
 */
import { Vid2ContextError } from '../errors.ts';
import { formatTimestamp } from '../segments.ts';
import { estimateTokens } from '../tokens.ts';
import type { VideoContext } from '../types.ts';
import type { FormatOptions, Formatter } from './index.ts';
import { paragraphLine } from './markdown.ts';
import {
  commentLines,
  escapeMd,
  excerpt,
  groupParagraphs,
  mediaEndSec,
  metadataLines,
  type Paragraph,
  quote,
  stamp,
  usesHours,
  visualLines,
} from './paragraphs.ts';

const FULL_DESCRIPTION_CHARS = 1500;
const SHORT_DESCRIPTION_CHARS = 200;
/** When timestamp density is reduced, one paragraph in this many keeps its link. */
const SPARSE_LINK_EVERY = 3;

interface Plan {
  comments: boolean;
  visual: boolean;
  linkEvery: number;
  descChars: number;
  /** Paragraphs kept per video; undefined keeps them all. */
  keep?: number[];
}

interface Video {
  context: VideoContext;
  paras: Paragraph[];
  /** Estimated tokens of each paragraph line, for proportional cutting. */
  cost: number[];
  heading: string;
  anchor: string;
}

/** GitHub-style heading anchor: lowercase, drop punctuation, spaces to hyphens. */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function prepare(contexts: VideoContext[]): Video[] {
  const many = contexts.length > 1;
  const seen = new Map<string, number>();
  return contexts.map((context, i) => {
    const paras = groupParagraphs(context.transcript.segments, context.metadata.chapters);
    const title = context.metadata.title.trim() || context.metadata.ref.id;
    const heading = many ? `Video ${i + 1}: ${title}` : title;
    let anchor = slugify(heading);
    const n = seen.get(anchor) ?? 0;
    seen.set(anchor, n + 1);
    if (n) anchor = `${anchor}-${n}`;
    return { context, paras, cost: paras.map((p) => estimateTokens(paragraphLine(context, p, true))), heading, anchor };
  });
}

function totalDuration(videos: Video[], hours: boolean): string {
  return formatTimestamp(
    videos.reduce((n, v) => n + (v.context.metadata.durationSec ?? mediaEndSec(v.context)), 0),
    hours,
  );
}

function renderVideo(v: Video, plan: Plan, index: number, opts: FormatOptions): string {
  const { context, paras } = v;
  const { metadata: m } = context;
  const hours = usesHours(context);
  const link = opts.linkTimestamps !== false;
  const out: string[] = [`## ${escapeMd(v.heading)}`, metadataLines(context).join('\n')];

  if (m.description?.trim()) {
    const full = m.description.trim();
    if (plan.descChars > 0) {
      const d = excerpt(full, plan.descChars);
      const note = d.cut ? `\n\n_Description shortened to ${d.text.length} of ${full.length} characters._` : '';
      out.push(`### Description\n\n${quote(d.text)}${note}`);
    } else {
      out.push(`### Description\n\n_Description (${full.length} characters) omitted for length._`);
    }
  }

  const chapters = [...m.chapters].sort((a, b) => a.startSec - b.startSec);
  if (chapters.length) {
    out.push(
      `### Chapters\n\n${chapters.map((c) => `- ${stamp(m.ref, c.startSec, hours, link)} ${escapeMd(c.title)}`).join('\n')}`,
    );
  }

  if (context.visual?.length && opts.includeVisual !== false) {
    out.push(
      plan.visual
        ? `### On screen\n\n${visualLines(context, link).join('\n')}`
        : `### On screen\n\n_${context.visual.length} on-screen notes omitted for length. They are in the json format._`,
    );
  }
  if (context.comments?.length && opts.includeComments !== false) {
    out.push(
      plan.comments
        ? `### Comments\n\n${commentLines(context.comments).join('\n')}`
        : `### Comments\n\n_${context.comments.length} comments omitted for length. Fetch them with the get_comments tool._`,
    );
  }

  out.push('### Transcript');
  const keep = plan.keep?.[index] ?? paras.length;
  let section = -1;
  for (let i = 0; i < keep; i++) {
    const p = paras[i] as Paragraph;
    const ch = chapters[p.chapter];
    if (p.chapter !== section && ch) out.push(`#### ${escapeMd(ch.title)} (${formatTimestamp(ch.startSec, hours)})`);
    section = p.chapter;
    out.push(paragraphLine(context, p, link && i % plan.linkEvery === 0));
  }
  if (!paras.length) out.push('_The transcript is empty._');
  if (keep < paras.length) {
    const from = formatTimestamp((paras[keep] as Paragraph).startSec, hours);
    const to = formatTimestamp(Math.max(...paras.map((p) => p.endSec)), hours);
    const what = keep === 0 ? 'The whole transcript' : 'The rest';
    out.push(`> ${what}, ${from} to ${to}, is omitted for length. Fetch it with the get_section tool or the full transcript.`);
  }
  return out.join('\n\n');
}

function renderPack(videos: Video[], plan: Plan, opts: FormatOptions): string {
  const hours = videos.some((v) => usesHours(v.context));
  const n = videos.length;
  // True when the budget made us leave something out (not when only links were thinned).
  const degraded = videos.some(
    (v, i) =>
      (!plan.comments && v.context.comments?.length && opts.includeComments !== false) ||
      (!plan.visual && v.context.visual?.length && opts.includeVisual !== false) ||
      (plan.descChars < FULL_DESCRIPTION_CHARS && (v.context.metadata.description?.trim().length ?? 0) > plan.descChars) ||
      (plan.keep?.[i] ?? v.paras.length) < v.paras.length,
  );
  const head = [
    '# Video context pack',
    `This document holds the transcripts and metadata of ${n === 1 ? 'one video' : `${n} videos`} (${totalDuration(videos, hours)} in total), prepared by vid2context for an AI model to read. Each transcript paragraph starts with the time it begins in the video, in brackets; linked times open the video at that moment.`,
    'Citation rule: when you use something from a video, cite it as [Title @ m:ss](link), using the time and link of the paragraph you drew on (or [Title @ m:ss] when the video has no link).',
  ];
  if (degraded && opts.maxTokens) {
    head.push(`Some content was left out to fit a budget of ${opts.maxTokens} tokens. Each cut is marked where it happened.`);
  }
  if (n > 1) {
    const toc = videos.map((v, i) => {
      const dur = formatTimestamp(v.context.metadata.durationSec ?? mediaEndSec(v.context), usesHours(v.context));
      return `${i + 1}. [${escapeMd(v.context.metadata.title, true)}](#${v.anchor}) (${dur})`;
    });
    head.push(`## Contents\n\n${toc.join('\n')}`);
  }
  return `${[...head, ...videos.map((v, i) => renderVideo(v, plan, i, opts))].join('\n\n')}\n`;
}

/** Keep about `f` (0..1) of each transcript, measured in tokens, cutting at paragraph boundaries. */
function keepFraction(videos: Video[], f: number): number[] {
  return videos.map((v) => {
    const total = v.cost.reduce((a, b) => a + b, 0);
    let sum = 0;
    let k = 0;
    while (k < v.cost.length && sum + (v.cost[k] ?? 0) <= f * total) sum += v.cost[k++] ?? 0;
    return k;
  });
}

export function renderPackMany(contexts: VideoContext[], opts: FormatOptions): string {
  if (!contexts.length) {
    throw new Vid2ContextError('bad-request', 'A context pack needs at least one video.', {
      hint: 'Pass one or more video URLs.',
    });
  }
  const videos = prepare(contexts);
  let plan: Plan = { comments: true, visual: true, linkEvery: 1, descChars: FULL_DESCRIPTION_CHARS };
  const budget = opts.maxTokens;
  const fits = (p: Plan) => {
    const s = renderPack(videos, p, opts);
    return budget === undefined || estimateTokens(s) <= budget ? s : null;
  };
  let out = fits(plan);
  if (out !== null) return out;

  const steps: Partial<Plan>[] = [
    { comments: false },
    { visual: false },
    { linkEvery: SPARSE_LINK_EVERY },
    { descChars: SHORT_DESCRIPTION_CHARS },
  ];
  for (const step of steps) {
    plan = { ...plan, ...step };
    out = fits(plan);
    if (out !== null) return out;
  }

  // Cut transcripts in proportion to their length: binary search the largest
  // kept fraction that fits.
  let lo = 0;
  let hi = 1;
  let best = fits({ ...plan, keep: keepFraction(videos, 0) });
  if (best === null) {
    plan = { ...plan, descChars: 0 };
    best = fits({ ...plan, keep: keepFraction(videos, 0) });
  }
  if (best === null) {
    const need = estimateTokens(renderPack(videos, { ...plan, keep: keepFraction(videos, 0) }, opts));
    throw new Vid2ContextError(
      'bad-request',
      `maxTokens ${budget} is too small for a context pack of ${videos.length} video(s): the headers alone need about ${need} tokens.`,
      { hint: `Raise maxTokens to at least ${need}, or pack fewer videos.` },
    );
  }
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const s = fits({ ...plan, keep: keepFraction(videos, mid) });
    if (s !== null) {
      best = s;
      lo = mid;
    } else hi = mid;
  }
  return best;
}

export const pack: Formatter = {
  id: 'pack',
  description:
    'Context pack: one Markdown file for one or many videos, written for an AI model to read, with citation instructions. Options: maxTokens, includeComments, includeVisual, linkTimestamps.',
  mimeType: 'text/markdown; charset=utf-8',
  extension: 'md',
  render(context, opts) {
    return renderPackMany([context], opts);
  },
  renderMany: renderPackMany,
};
