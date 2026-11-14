/**
 * Grounding for client-only mode, where the browser builds the prompt that
 * the server would build in server mode: each attached video's transcript is
 * cut into short timed excerpts, numbered [1], [2], ... across all videos,
 * and listed in a system message that tells the model to cite them. The
 * numbered excerpts become meta.sources, so [n] chips work the same way in
 * both modes. The raw transcript is never changed, only quoted.
 */
import { estimateTokens, formatTimestamp, segmentsToText, timestampUrl, type VideoContext } from '@vid2context/core';
import type { ChatSource } from './types.ts';

/** Target excerpt length. Short enough that a citation lands near the moment, long enough to hold a thought. */
export const EXCERPT_SEC = 45;

export interface Excerpt extends ChatSource {
  text: string;
}

/** Cut one transcript into excerpts of about EXCERPT_SEC seconds, at segment boundaries. */
export function excerptsOf(context: VideoContext, startN = 1, windowSec = EXCERPT_SEC): Excerpt[] {
  const ref = context.metadata.ref;
  const title = context.metadata.title;
  const out: Excerpt[] = [];
  let bucket: VideoContext['transcript']['segments'] = [];
  const flush = () => {
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    if (!first || !last) return;
    const text = segmentsToText(bucket);
    if (text) {
      const url = timestampUrl(ref, first.startSec);
      out.push({
        n: startN + out.length,
        videoId: ref.id,
        title,
        ...(url ? { url } : {}),
        startSec: first.startSec,
        endSec: last.endSec,
        text,
      });
    }
    bucket = [];
  };
  for (const seg of context.transcript.segments) {
    const first = bucket[0];
    if (first && seg.startSec - first.startSec >= windowSec) flush();
    bucket.push(seg);
  }
  flush();
  return out;
}

export function excerptLine(e: Excerpt): string {
  return `[${e.n}] ${e.title} (${formatTimestamp(e.startSec)}-${formatTimestamp(e.endSec)}): ${e.text}`;
}

export const GROUNDING_RULES = [
  'You answer questions about videos using the numbered transcript excerpts below.',
  'Cite every claim with the number of the excerpt it comes from in plain square brackets, like [3] or [2, 5], and nothing else inside the brackets.',
  'Cite only numbers that appear below. Do not invent quotes or timestamps.',
  'If the excerpts do not answer the question, say so plainly.',
  'Transcripts can contain recognition errors; prefer the meaning over exact wording.',
].join(' ');

export interface Grounding {
  /** The system message, or an empty string when no context is attached. */
  system: string;
  sources: ChatSource[];
  /** Excerpts left out to fit the budget. */
  omitted: number;
  tokens: number;
}

/**
 * Build the system message for the attached videos within `budgetTokens`.
 * When everything does not fit, excerpts are kept evenly spread across each
 * video (never just the beginning), and the message says how many were left
 * out. Source numbers stay stable whatever is cut.
 */
export function buildGrounding(contexts: VideoContext[], budgetTokens: number): Grounding {
  if (contexts.length === 0) return { system: '', sources: [], omitted: 0, tokens: 0 };
  const all: Excerpt[] = [];
  for (const ctx of contexts) all.push(...excerptsOf(ctx, all.length + 1));

  const header = (omitted: number) => {
    const videos = contexts
      .map((c) => {
        const ch = c.metadata.channel?.name ? ` by ${c.metadata.channel.name}` : '';
        const dur = c.metadata.durationSec ? `, ${formatTimestamp(c.metadata.durationSec)} long` : '';
        const origin = c.transcript.origin.replace(/-/g, ' ');
        return `- "${c.metadata.title}"${ch}${dur} (transcript: ${origin}, ${c.transcript.language})`;
      })
      .join('\n');
    const cut = omitted > 0 ? `\n\n${omitted} excerpts were left out to fit the model's context window.` : '';
    return `${GROUNDING_RULES}\n\nVideos:\n${videos}${cut}\n\nExcerpts:\n`;
  };

  const lines = all.map(excerptLine);
  const costs = lines.map((l) => estimateTokens(l) + 1);
  const total = costs.reduce((a, b) => a + b, 0);
  const headerCost = estimateTokens(header(all.length));
  if (headerCost + total <= budgetTokens) {
    const system = header(0) + lines.join('\n');
    return { system, sources: all.map(stripText), omitted: 0, tokens: estimateTokens(system) };
  }

  // Keep an evenly spread subset: take every k-th excerpt, raising k until it fits.
  const room = Math.max(0, budgetTokens - headerCost);
  const avg = total / all.length;
  let keepCount = Math.max(1, Math.floor(room / avg));
  for (;;) {
    const keep = spread(all.length, keepCount);
    const kept = keep.map((i) => all[i] as Excerpt);
    const cost = keep.reduce((a, i) => a + (costs[i] ?? 0), 0);
    if (cost <= room || keepCount <= 1) {
      const system = header(all.length - kept.length) + kept.map(excerptLine).join('\n');
      return { system, sources: kept.map(stripText), omitted: all.length - kept.length, tokens: estimateTokens(system) };
    }
    keepCount = Math.max(1, Math.floor(keepCount * 0.9));
  }
}

/** `count` indices spread evenly over [0, n). */
function spread(n: number, count: number): number[] {
  if (count >= n) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.floor((i * n) / count));
  return out;
}

function stripText(e: Excerpt): ChatSource {
  const { text: _text, ...source } = e;
  return source;
}

/** Estimated tokens a video adds to a conversation: its transcript plus a little metadata. */
export function contextTokens(context: VideoContext): number {
  return estimateTokens(segmentsToText(context.transcript.segments)) + estimateTokens(context.metadata.title) + 40;
}

/** About 12k tokens per hour of speech (docs/ARCHITECTURE.md), for videos whose transcript is not loaded. */
export function tokensFromDuration(durationSec: number | undefined): number | undefined {
  if (!durationSec || durationSec <= 0) return undefined;
  return Math.round((durationSec / 3600) * 12_000);
}
