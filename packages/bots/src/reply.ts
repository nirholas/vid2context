/**
 * The platform-neutral reply: video facts, the cited summary and the full
 * transcript as a text file. The transcript is the raw one from the pipeline;
 * the summary is an added layer, and when it fails the reply still carries
 * the transcript plus what went wrong.
 */
import {
  type ChainOptions,
  type Ctx,
  formatTimestamp,
  getVideoContext,
  type Registry,
  render,
  type Storage,
  timestampUrl,
  type VideoContext,
  Vid2ContextError,
  type VideoRef,
} from '@vid2context/core';
import { type Bullet, summarize } from './summary.ts';

export interface UserError {
  code: string;
  message: string;
  hint?: string;
}

export interface Citation {
  sec: number;
  label: string;
  url?: string;
}

export interface ReplyBullet {
  text: string;
  citations: Citation[];
}

export interface VideoReply {
  ref: VideoRef;
  title: string;
  url?: string;
  channel?: string;
  duration?: string;
  bullets: ReplyBullet[];
  /** Set when the summary could not be written; the transcript is still attached. */
  summaryError?: UserError;
  rung?: string;
  transcript: {
    filename: string;
    text: string;
    /** "auto-captions, en, 521 lines" */
    description: string;
  };
}

/** What a user is told when something fails: the error's message and recovery hint, never a stack. */
export function describeError(err: unknown): UserError {
  if (err instanceof Vid2ContextError) return { code: err.code, message: err.message, hint: err.hint };
  return { code: 'internal', message: 'Something went wrong on the server.', hint: 'Try again in a minute. The server log has the details.' };
}

/** A safe, readable file name from the video title. */
export function transcriptFilename(title: string, ref: VideoRef): string {
  const base = title
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/[-.]+$/, '');
  return `${base || ref.nativeId}-transcript.txt`;
}

function citations(ref: VideoRef, b: Bullet, long: boolean): Citation[] {
  return b.times.map((sec) => ({ sec, label: formatTimestamp(sec, long), url: timestampUrl(ref, sec) }));
}

export function transcriptText(context: VideoContext): string {
  const m = context.metadata;
  const t = context.transcript;
  const head = [
    m.title,
    m.ref.url ?? m.ref.input,
    m.channel?.name ? `Channel: ${m.channel.name}` : '',
    `Transcript: ${t.origin}, ${t.language}${t.translated ? ' (machine-translated)' : ''}, from ${t.producer}${t.model ? ` (${t.model})` : ''}`,
    'Made with vid2context.',
  ].filter(Boolean);
  return `${head.join('\n')}\n\n${render(context, 'text', { timestamps: true })}`;
}

/** Build the reply from an existing context (no network beyond the summary). */
export async function replyFromContext(
  registry: Registry,
  context: VideoContext,
  ctx: Ctx,
  chain: ChainOptions = {},
): Promise<VideoReply> {
  const m = context.metadata;
  const ref = m.ref;
  const durationSec = m.durationSec ?? context.transcript.segments.at(-1)?.endSec;
  const long = (durationSec ?? 0) >= 3600;
  const reply: VideoReply = {
    ref,
    title: m.title,
    url: ref.url,
    channel: m.channel?.name,
    duration: durationSec ? formatTimestamp(durationSec, long) : undefined,
    bullets: [],
    transcript: {
      filename: transcriptFilename(m.title, ref),
      text: transcriptText(context),
      description: `${context.transcript.origin}, ${context.transcript.language}, ${context.transcript.segments.length} lines`,
    },
  };
  try {
    const summary = await summarize(registry, context, ctx, chain);
    reply.rung = summary.rung;
    reply.bullets = summary.bullets.map((b) => ({ text: b.text, citations: citations(ref, b, long) }));
    if (reply.bullets.length === 0) {
      reply.summaryError = {
        code: 'upstream',
        message: 'The model answered without any bullet that cites a valid timestamp.',
        hint: 'Send the link again to retry; the transcript is attached either way.',
      };
    }
  } catch (err) {
    ctx.log.warn('bots: summary failed', { video: ref.id, code: describeError(err).code });
    reply.summaryError = describeError(err);
  }
  return reply;
}

/** Run the pipeline for one video, then summarize. Throws when no transcript can be had. */
export async function buildReply(
  registry: Registry,
  input: string,
  ctx: Ctx,
  opts: { chain?: ChainOptions; storage?: Storage | null } = {},
): Promise<VideoReply> {
  const context = await getVideoContext(registry, input, { mode: 'auto', storage: opts.storage ?? null }, ctx);
  return replyFromContext(registry, context, ctx, opts.chain);
}
