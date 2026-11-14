/**
 * keyMoments(): the moments of a video worth jumping to, picked by the LLM
 * chain (local, then free, then keyless rungs) from a compact timestamped
 * transcript. A long transcript is cut into chunks that fit the rungs'
 * context windows, each chunk gets a share of the moments by its duration,
 * and the answers are merged. Every timestamp the model returns is checked
 * against the real segments: snapped to the nearest segment start within 5
 * seconds, dropped otherwise, and the result says how many were dropped.
 */
import {
  type Attempt,
  attemptsOf,
  type ChainOptions,
  type ChatRequest,
  chat,
  estimateTokens,
  formatTimestamp,
  getVideoContext,
  rankRungs,
  type Segment,
  type TranscriptMode,
  timestampUrl,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { openStorage, type ResearchDeps } from './deps.ts';

export const SNAP_SEC = 5;
export const DEFAULT_COUNT = 8;
/** Prompt chunks never exceed this many estimated tokens, even on rungs with huge windows: smaller prompts are faster and keyless hosts are slow on big ones. */
export const MAX_CHUNK_TOKENS = 24_000;
/** Assumed window for a rung that does not declare contextTokens. */
const UNKNOWN_CONTEXT_TOKENS = 8_192;
const OUTPUT_TOKENS = 3_000;
const PROMPT_OVERHEAD_TOKENS = 600;

export const SYSTEM_PROMPT = [
  'You pick the key moments of a video from its transcript.',
  'Each transcript line starts with its start time in seconds, in square brackets.',
  'Choose the moments a viewer would most want to jump to: main topics, answers, verdicts, recommendations, demonstrations and turning points.',
  'Use only start times that appear at the beginning of a transcript line.',
  'Each title has at most 8 words. "why" is one short sentence saying what happens there and why it matters.',
  'Order the moments by importance, most important first.',
  'Return JSON: {"moments":[{"startSec":number,"title":string,"why":string}]}',
].join(' ');

export const MOMENTS_SCHEMA = {
  type: 'object',
  properties: {
    moments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { startSec: { type: 'number' }, title: { type: 'string' }, why: { type: 'string' } },
        required: ['startSec', 'title', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['moments'],
  additionalProperties: false,
} as const;

export interface KeyMomentsOptions {
  /** How many moments. Default 8, 1 to 30. */
  count?: number;
  /** Rung chain options (policy, only, skip). JSON support is always required. */
  chain?: ChainOptions;
  /** Override the per-chunk token budget computed from the rungs' context windows. */
  chunkTokens?: number;
  mode?: TranscriptMode;
  language?: string;
}

export interface KeyMoment {
  /** Start of the real segment the moment was snapped to. */
  startSec: number;
  timestamp: string;
  title: string;
  why: string;
  url?: string;
}

export interface DroppedMoment {
  startSec: unknown;
  title: string;
  reason: 'no-segment-within-5s' | 'invalid' | 'duplicate';
}

export interface KeyMomentsResult {
  videoId: string;
  title: string;
  url?: string;
  /** In video order. */
  moments: KeyMoment[];
  requested: number;
  /** Moments the model proposed, before validation. */
  proposed: number;
  /** How many proposals were dropped because no real segment starts within 5 seconds, they were malformed, or repeated another. */
  dropped: number;
  droppedMoments: DroppedMoment[];
  /** The rung that answered (the first chunk's, when chunks were answered by different rungs). */
  rung: string;
  rungs: string[];
  model: string;
  chunks: number;
  /** Every LLM rung tried, across chunks, in order. */
  attempts: Attempt[];
  notes: string[];
}

export interface TranscriptLine {
  startSec: number;
  text: string;
}

/** Merge segments into lines of about 10 seconds, each tagged with its whole-second start: compact and easy for a model to cite. */
export function compactLines(segments: Segment[], lineSec = 10): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  let cur: { start: number; parts: string[] } | null = null;
  for (const s of segments) {
    const text = s.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!cur || s.startSec - cur.start >= lineSec) {
      if (cur) out.push({ startSec: Math.floor(cur.start), text: cur.parts.join(' ') });
      cur = { start: s.startSec, parts: [] };
    }
    cur.parts.push(text);
  }
  if (cur) out.push({ startSec: Math.floor(cur.start), text: cur.parts.join(' ') });
  return out;
}

export const renderLine = (l: TranscriptLine): string => `[${l.startSec}] ${l.text}`;

/** Split lines into chunks of at most `maxTokens` estimated tokens each. */
export function chunkLines(lines: TranscriptLine[], maxTokens: number): TranscriptLine[][] {
  const chunks: TranscriptLine[][] = [];
  let cur: TranscriptLine[] = [];
  let used = 0;
  for (const l of lines) {
    const t = estimateTokens(renderLine(l)) + 1;
    if (cur.length > 0 && used + t > maxTokens) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(l);
    used += t;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/**
 * Transcript tokens per chunk: the smallest context window among the rungs
 * the chain may try (so a fallback rung never gets a prompt it cannot hold),
 * minus room for the instructions and the answer, capped at MAX_CHUNK_TOKENS.
 */
export function chunkBudget(deps: ResearchDeps, chain: ChainOptions): number {
  const ranked = rankRungs(
    deps.registry.llmRungs(deps.ctx.env),
    { ...chain, needs: [...(chain.needs ?? []), 'json'] },
    deps.ctx.env,
  );
  const tried = ranked.slice(0, chain.maxAttempts ?? 8);
  const smallest = tried.reduce((m, r) => Math.min(m, r.contextTokens ?? UNKNOWN_CONTEXT_TOKENS), Number.POSITIVE_INFINITY);
  const window = Number.isFinite(smallest) ? smallest : UNKNOWN_CONTEXT_TOKENS;
  return Math.max(500, Math.min(MAX_CHUNK_TOKENS, Math.floor((window - OUTPUT_TOKENS - PROMPT_OVERHEAD_TOKENS) * 0.85)));
}

/** The chat request for one chunk. Exported so tests can check the recorded fixture was made with this exact prompt. */
export function momentsRequest(
  context: VideoContext,
  chunk: TranscriptLine[],
  part: { index: number; total: number; count: number },
): ChatRequest {
  const m = context.metadata;
  const first = chunk[0]?.startSec ?? 0;
  const last = chunk.at(-1)?.startSec ?? first;
  const head = [
    `Video: ${m.title}`,
    m.channel?.name ? `Channel: ${m.channel.name}` : '',
    m.durationSec ? `Duration: ${formatTimestamp(m.durationSec)}` : '',
    part.total > 1
      ? `This is part ${part.index + 1} of ${part.total} of the transcript, from ${formatTimestamp(first)} to ${formatTimestamp(last)}.`
      : '',
    `Pick ${part.count} key moment${part.count === 1 ? '' : 's'}.`,
  ].filter(Boolean);
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${head.join('\n')}\n\nTranscript:\n${chunk.map(renderLine).join('\n')}` },
    ],
    json: { schema: MOMENTS_SCHEMA as unknown as Record<string, unknown>, name: 'key_moments' },
    maxTokens: OUTPUT_TOKENS,
    temperature: 0.2,
  };
}

interface RawMoment {
  startSec?: unknown;
  title?: unknown;
  why?: unknown;
}

/** Parse the model's JSON, tolerating code fences and text around the object. Returns null when there is no usable list. */
export function parseMoments(text: string): RawMoment[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { moments?: unknown };
    return Array.isArray(obj.moments) ? (obj.moments as RawMoment[]) : null;
  } catch {
    return null;
  }
}

/** Index of the segment whose start is closest to `sec` (segments sorted by start). */
export function nearestSegment(segments: Segment[], sec: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((segments[mid]?.startSec ?? 0) < sec) lo = mid + 1;
    else hi = mid;
  }
  const prev = lo - 1;
  if (prev >= 0 && Math.abs((segments[prev]?.startSec ?? 0) - sec) <= Math.abs((segments[lo]?.startSec ?? 0) - sec)) return prev;
  return lo;
}

/** Snap each proposed moment to a real segment start within SNAP_SEC seconds; drop the rest, saying why. */
export function validateMoments(
  raw: RawMoment[],
  context: VideoContext,
  taken: Set<number> = new Set(),
): { moments: KeyMoment[]; dropped: DroppedMoment[] } {
  const segments = context.transcript.segments;
  const moments: KeyMoment[] = [];
  const dropped: DroppedMoment[] = [];
  for (const r of raw) {
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const why = typeof r.why === 'string' ? r.why.trim() : '';
    const sec = typeof r.startSec === 'number' ? r.startSec : typeof r.startSec === 'string' ? Number(r.startSec) : Number.NaN;
    if (!Number.isFinite(sec) || !title || segments.length === 0) {
      dropped.push({ startSec: r.startSec, title, reason: 'invalid' });
      continue;
    }
    const seg = segments[nearestSegment(segments, sec)];
    if (!seg || Math.abs(seg.startSec - sec) > SNAP_SEC) {
      dropped.push({ startSec: sec, title, reason: 'no-segment-within-5s' });
      continue;
    }
    if (taken.has(seg.startSec)) {
      dropped.push({ startSec: sec, title, reason: 'duplicate' });
      continue;
    }
    taken.add(seg.startSec);
    const url = timestampUrl(context.metadata.ref, seg.startSec);
    moments.push({
      startSec: seg.startSec,
      timestamp: `[${formatTimestamp(seg.startSec)}]`,
      title,
      why,
      ...(url ? { url } : {}),
    });
  }
  return { moments, dropped };
}

/** Moments per chunk in proportion to its share of the video, at least one each. */
export function allocate(count: number, chunks: TranscriptLine[][], endSec: number): number[] {
  const starts = chunks.map((c) => c[0]?.startSec ?? 0);
  const spans = starts.map((s, i) => Math.max(1, (starts[i + 1] ?? endSec) - s));
  const total = spans.reduce((a, b) => a + b, 0);
  return spans.map((s) => Math.max(1, Math.round((count * s) / total)));
}

async function askChunk(
  req: ChatRequest,
  deps: ResearchDeps,
  chain: ChainOptions,
  attempts: Attempt[],
): Promise<{ raw: RawMoment[]; rung: string; model: string }> {
  // One retry on a different rung when the answer is not usable JSON: a model that ignored the format will likely do it again.
  let skip = chain.skip ?? [];
  for (let round = 0; round < 2; round++) {
    try {
      const res = await chat(deps.registry, req, { ...chain, skip, needs: [...(chain.needs ?? []), 'json'] }, deps.ctx);
      attempts.push(...res.attempts);
      const raw = parseMoments(res.text);
      if (raw) return { raw, rung: res.rung, model: res.model };
      attempts.push({ id: res.rung, stage: 'llm', outcome: 'error', reason: 'bad-json', detail: res.text.slice(0, 200) });
      skip = [...skip, res.rung];
    } catch (err) {
      throw Object.assign(err as object, { attempts: [...attempts, ...attemptsOf(err)] });
    }
  }
  throw Object.assign(
    new Vid2ContextError('upstream', 'The LLM answers for key moments were not valid JSON.', {
      hint: 'Retry, or set a key for a stronger free model (docs/providers.md).',
    }),
    { attempts },
  );
}

/** Pick `count` key moments of one video, each verified against the transcript. */
export async function keyMoments(url: string, opts: KeyMomentsOptions, deps: ResearchDeps): Promise<KeyMomentsResult> {
  const count = opts.count ?? DEFAULT_COUNT;
  if (!Number.isInteger(count) || count < 1 || count > 30) {
    throw new Vid2ContextError('bad-request', 'count must be a whole number from 1 to 30.', {
      hint: 'Pass count from 1 to 30, or leave it out for 8.',
    });
  }
  const storage = await openStorage(deps);
  const context = await getVideoContext(deps.registry, url, { storage, mode: opts.mode, language: opts.language }, deps.ctx);
  const segments = context.transcript.segments;
  const lines = compactLines(segments);
  if (lines.length === 0) {
    throw new Vid2ContextError('no-transcript', `The transcript of ${context.metadata.ref.id} is empty.`, {
      hint: 'Retry with mode "stt" to transcribe the audio.',
    });
  }
  const chain = opts.chain ?? {};
  const budget = opts.chunkTokens ?? chunkBudget(deps, chain);
  const chunks = chunkLines(lines, budget);
  const endSec = segments.at(-1)?.endSec ?? lines.at(-1)?.startSec ?? 0;
  const shares = chunks.length === 1 ? [count] : allocate(count, chunks, endSec);

  const attempts: Attempt[] = [];
  const answers: { raw: RawMoment[]; rung: string; model: string }[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const req = momentsRequest(context, chunk, { index, total: chunks.length, count: shares[index] ?? 1 });
    answers.push(await askChunk(req, deps, chain, attempts));
  }

  // Validate, then take moments round-robin across chunks in each chunk's importance order until `count`.
  const taken = new Set<number>();
  const perChunk = answers.map((a) => validateMoments(a.raw, context, taken));
  const droppedMoments = perChunk.flatMap((p) => p.dropped);
  const picked: KeyMoment[] = [];
  for (let rank = 0; picked.length < count; rank++) {
    const row = perChunk.map((p) => p.moments[rank]).filter((m): m is KeyMoment => m !== undefined);
    if (row.length === 0) break;
    for (const m of row) if (picked.length < count) picked.push(m);
  }
  const proposed = answers.reduce((n, a) => n + a.raw.length, 0);
  const extra = perChunk.reduce((n, p) => n + p.moments.length, 0) - picked.length;
  const notes: string[] = [];
  if (droppedMoments.length > 0) {
    const noSeg = droppedMoments.filter((d) => d.reason === 'no-segment-within-5s').length;
    notes.push(
      `Dropped ${droppedMoments.length} of ${proposed} proposed moments` +
        (noSeg > 0 ? ` (${noSeg} had no transcript segment starting within ${SNAP_SEC} seconds)` : '') +
        '.',
    );
  }
  if (extra > 0) notes.push(`Kept the ${count} most important of ${picked.length + extra} valid moments.`);
  if (picked.length < count) notes.push(`Only ${picked.length} of the ${count} requested moments could be verified.`);
  const rungs = [...new Set(answers.map((a) => a.rung))];
  return {
    videoId: context.metadata.ref.id,
    title: context.metadata.title,
    ...(context.metadata.ref.url ? { url: context.metadata.ref.url } : {}),
    moments: picked.sort((a, b) => a.startSec - b.startSec),
    requested: count,
    proposed,
    dropped: droppedMoments.length,
    droppedMoments,
    rung: rungs[0] ?? '',
    rungs,
    model: answers[0]?.model ?? '',
    chunks: chunks.length,
    attempts,
    notes,
  };
}

/** Plain text for agents: one cited line per moment. */
export function renderKeyMoments(r: KeyMomentsResult): string {
  const lines = [
    `Key moments of "${r.title}"${r.url ? ` (${r.url})` : ''}: ${r.moments.length} verified against the transcript, chosen by ${r.rung}.`,
    ...r.notes.map((n) => `Note: ${n}`),
    '',
    ...r.moments.map((m) => `${m.url ? `[${formatTimestamp(m.startSec)}](${m.url})` : m.timestamp} ${m.title}: ${m.why}`),
  ];
  return `${lines.join('\n')}\n`;
}
