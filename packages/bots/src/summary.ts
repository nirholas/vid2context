/**
 * The chat summary: 5 to 8 bullets, each ending in the [m:ss] where its point
 * is made. The LLM sees the transcript as timestamped blocks; every timestamp
 * it cites is checked against the real segments and invalid ones are dropped,
 * so a link in the reply always opens the video where the point is made.
 */
import {
  type ChainOptions,
  type ChatRequest,
  type Ctx,
  chat,
  formatTimestamp,
  type Registry,
  type Segment,
  type VideoContext,
} from '@vid2context/core';

export const SUMMARY_SYSTEM_PROMPT = [
  'You summarize a video transcript for a chat message.',
  'Reply with 5 to 8 bullet points and nothing else: no title, no introduction, no closing remarks.',
  'Each bullet is one line that starts with "- ", states one concrete point from the video in at most 30 words,',
  'and ends with the timestamp where that point is made, in square brackets exactly as it appears at the start of a transcript line, for example [3:25].',
  'Use only timestamps that appear in the transcript. Cover the whole video in order.',
  'Write in the language of the transcript. A very short video may get fewer bullets.',
].join(' ');

/** Transcript characters sent to the model: about 6k tokens, under the per-minute caps of the free tiers. */
export const MAX_TRANSCRIPT_CHARS = 24_000;
/** A block closes after this many seconds or characters. */
const BLOCK_SEC = 20;
const BLOCK_CHARS = 400;

export interface Block {
  startSec: number;
  text: string;
}

/** Merge consecutive segments into blocks of about 20 seconds, each cited by its start. */
export function toBlocks(segments: Segment[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const s of segments) {
    const text = s.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (cur && s.startSec - cur.startSec < BLOCK_SEC && cur.text.length + text.length < BLOCK_CHARS) {
      cur.text += ` ${text}`;
      continue;
    }
    cur = { startSec: s.startSec, text };
    blocks.push(cur);
  }
  return blocks;
}

/** Evenly sample blocks so the transcript fits the budget while still covering the whole video. */
export function fitBlocks(blocks: Block[], maxChars: number): { blocks: Block[]; sampled: boolean } {
  const total = blocks.reduce((n, b) => n + b.text.length + 10, 0);
  if (total <= maxChars || blocks.length < 2) return { blocks, sampled: false };
  const keep = Math.max(2, Math.floor((blocks.length * maxChars) / total));
  const out: Block[] = [];
  for (let i = 0; i < keep; i++) {
    const b = blocks[Math.round((i * (blocks.length - 1)) / (keep - 1))];
    if (b && out.at(-1) !== b) out.push(b);
  }
  return { blocks: out, sampled: true };
}

function durationOf(context: VideoContext): number {
  return context.metadata.durationSec ?? context.transcript.segments.at(-1)?.endSec ?? 0;
}

export function buildSummaryRequest(context: VideoContext, maxChars = MAX_TRANSCRIPT_CHARS): ChatRequest {
  const duration = durationOf(context);
  const long = duration >= 3600;
  const { blocks, sampled } = fitBlocks(toBlocks(context.transcript.segments), maxChars);
  const lines = blocks.map((b) => `[${formatTimestamp(b.startSec, long)}] ${b.text}`).join('\n');
  const head = [
    `Title: ${context.metadata.title}`,
    context.metadata.channel?.name ? `Channel: ${context.metadata.channel.name}` : '',
    duration ? `Duration: ${formatTimestamp(duration, long)}` : '',
  ].filter(Boolean);
  const label = sampled
    ? 'Transcript excerpts, evenly spaced across the whole video (each line starts with its time):'
    : 'Transcript (each line starts with its time):';
  return {
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: `${head.join('\n')}\n\n${label}\n${lines}` },
    ],
    maxTokens: 2000,
    temperature: 0.2,
  };
}

export interface Bullet {
  text: string;
  /** Validated citation times in seconds, at least one. */
  times: number[];
}

const STAMP = /\d{1,2}(?::\d{2}){1,2}/g;
const TRAILING_STAMPS = /((?:\s*[([]\s*\d{1,2}(?::\d{2}){1,2}(?:\s*(?:[,;]|and|-)\s*\d{1,2}(?::\d{2}){1,2})*\s*[)\]])+)\s*[.,;]?\s*$/;

/** "1:02:03" -> 3723, "3:25" -> 205. */
export function parseTimestamp(s: string): number | null {
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (parts.slice(1).some((n) => n >= 60)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** A cited time is valid when it falls inside (or within a second of) a real segment. */
export function validTime(segments: Segment[], sec: number): boolean {
  return segments.some((s) => sec >= Math.floor(s.startSec) - 1 && sec <= Math.ceil(s.endSec));
}

/**
 * Parse the model's answer into bullets. Lines that are not bullets are
 * ignored; timestamps that match no segment are dropped; a bullet left with
 * no valid timestamp is dropped. At most 8 bullets are kept.
 */
export function parseSummary(text: string, segments: Segment[]): Bullet[] {
  const bullets: Bullet[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (!m?.[1]) continue;
    let body = m[1].replace(/\*\*/g, '').trim();
    const tail = body.match(TRAILING_STAMPS);
    if (!tail?.[1]) continue;
    const times: number[] = [];
    for (const stamp of tail[1].match(STAMP) ?? []) {
      const sec = parseTimestamp(stamp);
      if (sec !== null && validTime(segments, sec) && !times.includes(sec)) times.push(sec);
    }
    body = body
      .slice(0, body.length - tail[0].length)
      .trim()
      .replace(/[\s,;:]+$/, '');
    if (!body || times.length === 0) continue;
    bullets.push({ text: body, times });
    if (bullets.length >= 8) break;
  }
  return bullets;
}

export interface Summary {
  bullets: Bullet[];
  /** The LLM rung that wrote it. */
  rung: string;
}

/** Ask the free-first LLM chain for the summary and keep only bullets with valid timestamps. */
export async function summarize(
  registry: Registry,
  context: VideoContext,
  ctx: Ctx,
  chain: ChainOptions = {},
): Promise<Summary> {
  const res = await chat(registry, buildSummaryRequest(context), chain, ctx);
  return { bullets: parseSummary(res.text, context.transcript.segments), rung: res.rung };
}
