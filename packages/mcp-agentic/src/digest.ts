/**
 * digest_videos: map-reduce over transcripts with MCP sampling, so the
 * client's own model writes the digest and the user needs no server key.
 *
 *   map     one sampling call per chunk: bullet notes, each ending in [m:ss]
 *   check   every timestamp is verified against the real segments
 *   reduce  one sampling call combines the verified notes into a digest that
 *           cites [Title @ m:ss]; citations are verified again and rewritten
 *           to deep links
 *
 * Without client sampling support the tool returns the chunk plan and the
 * exact instructions instead, so the agent can do the same work itself.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  type CreateMessageRequest,
  McpError,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type Ctx,
  formatTimestamp,
  type Registry,
  type Storage,
  timestampUrl,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { z } from 'zod';
import {
  chunkTranscript,
  DEFAULT_MAX_TOKENS_PER_CHUNK,
  MIN_TOKENS_PER_CHUNK,
  needsHours,
  type TranscriptChunk,
  videoDuration,
} from './chunking.ts';
import { type CitationSource, checkDigest, checkNotes, DEFAULT_TOLERANCE_SEC, type DroppedClaim, sourceOf } from './citations.ts';
import { type InputProblem, resolveSources } from './inputs.ts';
import {
  MAP_MAX_TOKENS,
  MAP_MODEL_PREFERENCES,
  MAP_SYSTEM,
  mapUserMessage,
  REDUCE_MAX_TOKENS,
  REDUCE_MODEL_PREFERENCES,
  REDUCE_SYSTEM,
  reduceUserMessage,
} from './prompts.ts';
import { clientSupportsSampling, type ToolResult, text, toolError } from './shared.ts';

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Map calls in flight at once. Some clients serialize sampling, so more would only queue. */
export const DEFAULT_CONCURRENCY = 3;
/** How long one sampling call may take: the client may ask the user to approve it first. */
export const SAMPLING_TIMEOUT_MS = 5 * 60 * 1000;
/** JSON-RPC error code clients return when the user rejects a sampling request (MCP spec). */
const USER_REJECTED = -1;

export const digestInputSchema = {
  urls: z
    .array(z.string().min(1))
    .optional()
    .describe('Video URLs, playlists or channels (expanded into their videos), saved video ids or titles'),
  collection: z.string().optional().describe('A collection id or name; its saved videos are digested'),
  question: z.string().optional().describe('A question the digest should answer'),
  maxTokensPerVideo: z
    .number()
    .int()
    .min(MIN_TOKENS_PER_CHUNK)
    .max(200_000)
    .optional()
    .describe(
      `Most transcript tokens sent in one sampling call; longer videos are split by chapter or time. Default ${DEFAULT_MAX_TOKENS_PER_CHUNK}`,
    ),
};

export interface DigestArgs {
  urls?: string[];
  collection?: string;
  question?: string;
  maxTokensPerVideo?: number;
}

export interface DigestOptions {
  concurrency?: number;
  toleranceSec?: number;
}

/** Run `fn` over items with at most `limit` in flight. Stops starting new items once `stop()` is true. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  stop: () => boolean,
): Promise<(PromiseSettledResult<R> | undefined)[]> {
  const results: (PromiseSettledResult<R> | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const i = next++;
      const item = items[i] as T;
      try {
        results[i] = { status: 'fulfilled', value: await fn(item, i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Text of a sampling result (a single content block or an array). */
function resultText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b) =>
      b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '',
    )
    .join('')
    .trim();
}

async function sample(
  server: McpServer,
  extra: Extra,
  params: CreateMessageRequest['params'],
): Promise<{ text: string; model: string }> {
  const res = await server.server.createMessage(params, {
    signal: extra.signal,
    relatedRequestId: extra.requestId,
    timeout: SAMPLING_TIMEOUT_MS,
  });
  const out = resultText(res.content);
  if (!out) throw new Vid2ContextError('upstream', 'The client returned an empty sampling result.');
  return { text: out, model: res.model };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sourceLine(c: VideoContext, n: number): string {
  const m = c.metadata;
  const bits = [
    m.channel?.name,
    formatTimestamp(videoDuration(c), needsHours(c)),
    `${c.transcript.origin}, ${c.transcript.language}`,
  ].filter(Boolean);
  return `${n}. ${m.ref.url ? `[${m.title}](${m.ref.url})` : m.title} (${bits.join(', ')})`;
}

function problemLines(problems: InputProblem[], truncated?: number): string[] {
  const lines = problems.map((p) => `- ${p.input}: ${p.error}: ${p.message}`);
  if (truncated) lines.push(`- ${truncated} more videos were found but left out: one digest reads at most the first ones.`);
  return lines;
}

/** The plan returned when the client cannot sample: what to read, in which pieces, and the exact instructions. */
export function buildChunkPlan(contexts: VideoContext[], chunks: TranscriptChunk[], args: DigestArgs, problems: InputProblem[]) {
  return {
    mode: 'chunk-plan',
    why: 'This client does not support MCP sampling, so the server cannot ask your model to write the digest. Do the same work yourself: the steps, chunks and instructions below are exactly what the server would have sent.',
    ...(args.question ? { question: args.question } : {}),
    steps: [
      'For each chunk, fetch that time range of the transcript (get_section with url, from and to in seconds; or get_transcript and read the lines between from and to).',
      'Write notes for the chunk following mapInstructions, with the chunk details as context.',
      'Keep only notes whose [m:ss] really appears in that chunk.',
      'Combine all notes following reduceInstructions into one digest.',
      'Cite as [Title @ m:ss](link), where link is the video URL at that second (see timestampLink).',
    ],
    videos: contexts.map((c, i) => ({
      n: i + 1,
      id: c.metadata.ref.id,
      title: c.metadata.title,
      url: c.metadata.ref.url,
      channel: c.metadata.channel?.name,
      durationSec: videoDuration(c),
      chapters: c.metadata.chapters.length,
      transcript: `${c.transcript.origin}, ${c.transcript.language}`,
      timestampLink: timestampUrl(c.metadata.ref, 0)?.replace(/0(s?)$/, '{seconds}$1'),
    })),
    chunks: chunks.map((ch) => {
      const c = contexts[ch.videoIndex] as VideoContext;
      const long = needsHours(c);
      return {
        video: ch.videoIndex + 1,
        chunk: ch.index + 1,
        of: ch.of,
        from: formatTimestamp(ch.fromSec, long),
        to: formatTimestamp(ch.toSec, long),
        fromSec: Math.floor(ch.fromSec),
        toSec: Math.ceil(ch.toSec),
        ...(ch.chapters.length > 0 ? { chapters: ch.chapters } : {}),
        estimatedTokens: ch.estimatedTokens,
        fetch: {
          tool: 'get_section',
          arguments: { url: c.metadata.ref.url ?? c.metadata.ref.input, from: Math.floor(ch.fromSec), to: Math.ceil(ch.toSec) },
        },
      };
    }),
    mapInstructions: MAP_SYSTEM,
    reduceInstructions: REDUCE_SYSTEM,
    ...(problems.length > 0 ? { problems } : {}),
  };
}

interface MapOutcome {
  chunk: TranscriptChunk;
  notes?: string;
  model?: string;
  error?: string;
  verified: number;
  dropped: DroppedClaim[];
}

export async function runDigest(
  server: McpServer,
  deps: { registry: Registry; storage: (ctx: Ctx) => Promise<Storage | null> },
  args: DigestArgs,
  ctx: Ctx,
  extra: Extra,
  opts: DigestOptions = {},
): Promise<ToolResult> {
  if (!args.collection && (!args.urls || args.urls.length === 0)) {
    return toolError(
      new Vid2ContextError('bad-request', 'digest_videos needs `urls` or `collection`.', {
        hint: 'Pass one or more video or playlist URLs, or a collection id.',
      }),
    );
  }
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const storage = await deps.storage(ctx);
  const resolved = await resolveSources(deps.registry, storage, args, ctx);
  const { contexts, problems } = resolved;
  if (contexts.length === 0) {
    return toolError(
      Object.assign(
        new Vid2ContextError('no-transcript', 'None of the inputs produced a transcript.', {
          hint: problems.map((p) => `${p.input}: ${p.message}`).join(' | ') || 'Check the inputs.',
        }),
        { attempts: [] },
      ),
    );
  }

  const chunks = contexts.flatMap((c, i) => chunkTranscript(c, i, { maxTokens: args.maxTokensPerVideo }));
  if (!clientSupportsSampling(server)) {
    return text(JSON.stringify(buildChunkPlan(contexts, chunks, args, problems), null, 2));
  }

  const sources = contexts.map(sourceOf);
  const total = chunks.length + 1;
  let done = 0;
  const progressToken = extra._meta?.progressToken;
  // Progress must increase with every notification: map calls count 1..n, combining is n + 0.5, done is n + 1.
  const progress = async (message: string, value = done) => {
    if (progressToken === undefined) return;
    await extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: value, total, message },
    });
  };

  let rejectedByUser = false;
  const settled = await mapLimit(
    chunks,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    async (chunk): Promise<MapOutcome> => {
      const context = contexts[chunk.videoIndex] as VideoContext;
      const source = sources[chunk.videoIndex] as CitationSource;
      let res: { text: string; model: string };
      try {
        res = await sample(server, extra, {
          messages: [{ role: 'user', content: { type: 'text', text: mapUserMessage(context, chunk, args.question) } }],
          systemPrompt: MAP_SYSTEM,
          maxTokens: MAP_MAX_TOKENS,
          temperature: 0.2,
          modelPreferences: MAP_MODEL_PREFERENCES,
        });
      } catch (err) {
        // One rejection means the user said no: do not ask again for every remaining chunk.
        if (err instanceof McpError && err.code === USER_REJECTED) rejectedByUser = true;
        throw err;
      }
      const checked = checkNotes(res.text, source, { toleranceSec: tolerance, range: chunk });
      done++;
      await progress(`Notes ${done} of ${chunks.length}: ${context.metadata.title} part ${chunk.index + 1} of ${chunk.of}`);
      return { chunk, notes: checked.text, model: res.model, verified: checked.verified, dropped: checked.dropped };
    },
    () => rejectedByUser || Boolean(extra.signal.aborted),
  );

  if (extra.signal.aborted) {
    return toolError(new Vid2ContextError('timeout', 'digest_videos was cancelled.', { hint: 'Call it again to restart.' }));
  }

  const outcomes: MapOutcome[] = settled.map((s, i) => {
    const chunk = chunks[i] as TranscriptChunk;
    if (!s) return { chunk, error: 'not started: an earlier sampling request was rejected', verified: 0, dropped: [] };
    if (s.status === 'fulfilled') return s.value;
    return { chunk, error: errMessage(s.reason), verified: 0, dropped: [] };
  });
  const ok = outcomes.filter((o) => o.notes !== undefined);
  const failed = outcomes.filter((o) => o.error !== undefined);
  if (ok.length === 0) {
    const first = failed[0]?.error ?? 'unknown error';
    return toolError(
      new Vid2ContextError('upstream', `Every sampling request failed (${failed.length}). First error: ${first}`, {
        hint: rejectedByUser
          ? 'The user rejected the sampling request. Approve it to build the digest, or read the transcripts with get_transcript and write the digest yourself.'
          : 'Retry, or read the transcripts with get_transcript and write the digest yourself.',
      }),
    );
  }

  const notesBySource = contexts.map((context, i) => ({
    context,
    notes: ok
      .filter((o) => o.chunk.videoIndex === i)
      .sort((a, b) => a.chunk.index - b.chunk.index)
      .map((o) => o.notes)
      .filter(Boolean)
      .join('\n'),
  }));
  const droppedNotes = ok.flatMap((o) =>
    o.dropped.map((d) => ({ ...d, video: contexts[o.chunk.videoIndex]?.metadata.title ?? o.chunk.videoId })),
  );
  const models = new Set(ok.map((o) => o.model).filter((m): m is string => Boolean(m)));

  await progress('Combining notes', chunks.length + 0.5);
  let digestText: string;
  let digestCitations = 0;
  let droppedDigest: DroppedClaim[] = [];
  let reduceError: string | undefined;
  try {
    const res = await sample(server, extra, {
      messages: [{ role: 'user', content: { type: 'text', text: reduceUserMessage(notesBySource, args.question) } }],
      systemPrompt: REDUCE_SYSTEM,
      maxTokens: REDUCE_MAX_TOKENS,
      temperature: 0.2,
      modelPreferences: REDUCE_MODEL_PREFERENCES,
    });
    models.add(res.model);
    const checked = checkDigest(res.text, sources, { toleranceSec: tolerance });
    digestText = checked.text;
    digestCitations = checked.citations;
    droppedDigest = checked.dropped;
    done++;
    await progress('Digest ready', total);
  } catch (err) {
    if (extra.signal.aborted) {
      return toolError(new Vid2ContextError('timeout', 'digest_videos was cancelled.', { hint: 'Call it again to restart.' }));
    }
    reduceError = errMessage(err);
    // Keep the work already done: the verified notes, each linked to its source.
    digestText = notesBySource
      .map((s) => {
        const checked = checkDigest(s.notes, [sourceOf(s.context)], { toleranceSec: tolerance });
        digestCitations += checked.citations;
        return `## ${s.context.metadata.title}\n${checked.text}`;
      })
      .join('\n\n');
  }

  const lines = [
    `# Digest of ${contexts.length} video${contexts.length === 1 ? '' : 's'}`,
    args.question ? `Question: ${args.question}` : undefined,
    '',
    reduceError
      ? `The combine step failed (${reduceError}), so these are the verified notes per video instead of a combined digest.\n`
      : undefined,
    digestText,
    '',
    '---',
    'Sources:',
    ...contexts.map((c, i) => sourceLine(c, i + 1)),
    '',
    `Built with MCP sampling by the client's model (${[...models].join(', ') || 'model not reported'}): ${ok.length} of ${chunks.length} note calls succeeded, ${reduceError ? 'the combine call failed' : '1 combine call'}.`,
    `Citation check (tolerance ${tolerance} s): ${digestCitations} citations verified against the transcripts; ${droppedNotes.length} note lines and ${droppedDigest.length} digest lines dropped because their timestamps do not exist in the source.`,
  ];
  if (droppedNotes.length + droppedDigest.length > 0) {
    lines.push('', 'Dropped claims:');
    for (const d of droppedNotes) lines.push(`- (notes, ${d.video}) ${d.text} [${d.reason}]`);
    for (const d of droppedDigest) lines.push(`- (digest) ${d.text} [${d.reason}]`);
  }
  if (failed.length > 0) {
    lines.push('', 'Chunks without notes:');
    for (const f of failed) {
      const c = contexts[f.chunk.videoIndex] as VideoContext;
      const long = needsHours(c);
      lines.push(
        `- ${c.metadata.title} ${formatTimestamp(f.chunk.fromSec, long)} to ${formatTimestamp(f.chunk.toSec, long)}: ${f.error}`,
      );
    }
  }
  const probs = problemLines(problems, resolved.truncated);
  if (probs.length > 0) lines.push('', 'Inputs that could not be read:', ...probs);
  return text(lines.filter((l) => l !== undefined).join('\n'));
}
