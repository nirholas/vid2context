/**
 * SponsorBlock lookups: crowdsourced segments of YouTube videos that are
 * sponsor reads, self-promotion, subscribe reminders, intros, outros and more.
 *
 * Privacy: the request carries only the first 4 hex characters of
 * sha256(videoId). The server answers with every video sharing that prefix
 * (usually 100 to 200) and the exact video is picked out here, so the API
 * never learns which video was asked for.
 *
 * Runtime-neutral: ctx.fetch and WebCrypto only, so it runs on Node, Workers
 * and in the browser. Data license: CC BY-NC-SA 4.0 (see SPONSORBLOCK_ATTRIBUTION).
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError, type VideoRef } from '@vid2context/core';

/** Every category the SponsorBlock API serves (checked live on 2026-11-14). */
export const SKIP_CATEGORIES = [
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
  'preview',
  'hook',
  'filler',
  'music_offtopic',
  'poi_highlight',
  'exclusive_access',
  'chapter',
] as const;

export type SkipCategory = (typeof SKIP_CATEGORIES)[number];

/** What gets looked up when the caller names no categories and VID2CONTEXT_SKIP_CATEGORIES is unset. */
export const DEFAULT_SKIP_CATEGORIES: readonly SkipCategory[] = [
  'sponsor',
  'selfpromo',
  'interaction',
  'intro',
  'outro',
  'preview',
  'filler',
];

/**
 * What a segment means for playback:
 * skip     the span can be skipped.
 * mute     the span's audio is the labelled content (skipped here too: its speech is the ad).
 * full     the whole video is labelled (sponsored, self-promotion, exclusive access); start and end are 0.
 * poi      a point of interest (the highlight); start equals end.
 * chapter  a community chapter title in `description`.
 */
export type SkipActionType = 'skip' | 'mute' | 'full' | 'poi' | 'chapter';

const ACTION_TYPES: readonly SkipActionType[] = ['skip', 'mute', 'full', 'poi', 'chapter'];

export interface SkipSegment {
  category: SkipCategory;
  startSec: number;
  endSec: number;
  /** Community votes; segments below zero are never returned. */
  votes: number;
  uuid: string;
  actionType: SkipActionType;
  /** Locked by a SponsorBlock VIP, which counts as verified. */
  locked?: boolean;
  /** Chapter title for `chapter` segments. */
  description?: string;
}

export interface SkipLookup {
  /** The ref id, `youtube:<videoId>`, or the input ref's id for platforms SponsorBlock does not cover. */
  videoId: string;
  /** Spans to skip (`skip` and `mute`), overlaps resolved, sorted by start time. */
  segments: SkipSegment[];
  /** The best-voted `poi_highlight`: a point, not a span to skip. */
  highlight?: SkipSegment;
  /** Set when the whole video is labelled sponsored, self-promotion or exclusive access. A flag only: nothing is removed for it. */
  fullVideo?: SkipSegment;
  /** Community chapters, when the `chapter` category was asked for. */
  chapters: SkipSegment[];
  /** False when nothing was looked up: not YouTube, or VID2CONTEXT_SPONSORBLOCK=0. */
  looked: boolean;
}

export interface SkipOptions {
  /** Categories to look up. Default: VID2CONTEXT_SKIP_CATEGORIES, else DEFAULT_SKIP_CATEGORIES. */
  categories?: readonly SkipCategory[];
  /** Drop segments with fewer votes than this, unless locked. Default 0. Negative votes are always dropped. */
  minVotes?: number;
  /** Request timeout. Default 5000 ms: skipping ads must never hold up a transcript. */
  timeoutMs?: number;
}

export const SPONSORBLOCK_ATTRIBUTION = 'Segment data: SponsorBlock (sponsor.ajay.app), CC BY-NC-SA 4.0';
export const DEFAULT_SPONSORBLOCK_API_URL = 'https://sponsor.ajay.app';
const DEFAULT_TIMEOUT_MS = 5_000;

const CATEGORY_SET = new Set<string>(SKIP_CATEGORIES);

export function isSkipCategory(value: string): value is SkipCategory {
  return CATEGORY_SET.has(value);
}

/**
 * Parse a comma-separated category list ("sponsor, selfpromo"). Unknown names
 * are the caller's mistake, so they throw `bad-request` listing the valid ones.
 */
export function parseCategories(list: string | readonly string[]): SkipCategory[] {
  const items = (typeof list === 'string' ? list.split(',') : [...list]).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = items.filter((s) => !isSkipCategory(s));
  if (unknown.length > 0) {
    throw new Vid2ContextError(
      'bad-request',
      `Unknown SponsorBlock categor${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}.`,
      {
        hint: `Use any of: ${SKIP_CATEGORIES.join(', ')}.`,
      },
    );
  }
  return [...new Set(items as SkipCategory[])];
}

/** True unless VID2CONTEXT_SPONSORBLOCK turns lookups off (0, false, off, no). */
export function sponsorBlockEnabled(ctx: Ctx): boolean {
  const v = ctx.env.VID2CONTEXT_SPONSORBLOCK?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** The categories to use when the caller names none: VID2CONTEXT_SKIP_CATEGORIES, else the defaults. Unknown env names are skipped with a warning. */
export function defaultCategories(ctx: Ctx): SkipCategory[] {
  const raw = ctx.env.VID2CONTEXT_SKIP_CATEGORIES?.trim();
  if (!raw) return [...DEFAULT_SKIP_CATEGORIES];
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = names.filter((s) => !isSkipCategory(s));
  if (bad.length > 0) ctx.log.warn('VID2CONTEXT_SKIP_CATEGORIES has unknown categories; ignoring them', { unknown: bad });
  const good = names.filter(isSkipCategory);
  return good.length > 0 ? [...new Set(good)] : [...DEFAULT_SKIP_CATEGORIES];
}

/** Base URL of the SponsorBlock API, from SPONSORBLOCK_API_URL (a self-hosted mirror) or the public server. */
export function sponsorBlockBaseUrl(ctx: Ctx): string {
  const raw = ctx.env.SPONSORBLOCK_API_URL?.trim() || DEFAULT_SPONSORBLOCK_API_URL;
  return raw.replace(/\/+$/, '').replace(/\/api$/, '');
}

/** First `length` hex characters of sha256(videoId), via WebCrypto. */
export async function hashPrefix(videoId: string, length = 4): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(videoId));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, length);
}

/** The hash-prefix request for one video and a set of categories. Every action type is asked for, so `full` and `poi` labels arrive too. */
export async function skipSegmentsUrl(ctx: Ctx, videoId: string, categories: readonly SkipCategory[]): Promise<string> {
  const prefix = await hashPrefix(videoId);
  const q = new URLSearchParams({ categories: JSON.stringify(categories), actionTypes: JSON.stringify(ACTION_TYPES) });
  return `${sponsorBlockBaseUrl(ctx)}/api/skipSegments/${prefix}?${q.toString()}`;
}

interface RawSegment {
  segment?: unknown;
  UUID?: unknown;
  category?: unknown;
  actionType?: unknown;
  votes?: unknown;
  locked?: unknown;
  description?: unknown;
}

function toSkipSegment(raw: RawSegment): SkipSegment | undefined {
  const seg = raw.segment;
  if (!Array.isArray(seg) || seg.length < 2) return undefined;
  const [startSec, endSec] = seg as unknown[];
  if (typeof startSec !== 'number' || typeof endSec !== 'number' || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    return undefined;
  }
  if (typeof raw.category !== 'string' || !isSkipCategory(raw.category)) return undefined;
  const actionType = (typeof raw.actionType === 'string' ? raw.actionType : 'skip') as SkipActionType;
  if (!ACTION_TYPES.includes(actionType)) return undefined;
  const out: SkipSegment = {
    category: raw.category,
    startSec: Math.max(0, Math.min(startSec, endSec)),
    endSec: Math.max(0, startSec, endSec),
    votes: typeof raw.votes === 'number' ? raw.votes : 0,
    uuid: typeof raw.UUID === 'string' ? raw.UUID : '',
    actionType,
  };
  if (raw.locked === 1 || raw.locked === true) out.locked = true;
  if (typeof raw.description === 'string' && raw.description) out.description = raw.description;
  return out;
}

/** When two segments tie on votes, the more specific label wins (a sponsor read over an outro it overlaps). */
const CATEGORY_RANK: Record<SkipCategory, number> = {
  sponsor: 0,
  selfpromo: 1,
  exclusive_access: 2,
  interaction: 3,
  hook: 4,
  intro: 5,
  outro: 6,
  preview: 7,
  music_offtopic: 8,
  filler: 9,
  poi_highlight: 10,
  chapter: 11,
};

function better(a: SkipSegment, b: SkipSegment): number {
  return (
    b.votes - a.votes ||
    Number(b.locked ?? false) - Number(a.locked ?? false) ||
    CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
    b.endSec - b.startSec - (a.endSec - a.startSec) ||
    a.uuid.localeCompare(b.uuid)
  );
}

/** The parts of [start, end] not covered by `taken` (sorted, non-overlapping). */
function subtract(start: number, end: number, taken: { startSec: number; endSec: number }[]): [number, number][] {
  const pieces: [number, number][] = [];
  let cursor = start;
  for (const t of taken) {
    if (t.endSec <= cursor) continue;
    if (t.startSec >= end) break;
    if (t.startSec > cursor) pieces.push([cursor, t.startSec]);
    cursor = Math.max(cursor, t.endSec);
    if (cursor >= end) break;
  }
  if (cursor < end) pieces.push([cursor, end]);
  return pieces;
}

/**
 * Resolve overlapping spans, preferring more votes (then locked, then the more
 * specific category). A weaker segment that is mostly covered (half or more of
 * its length) by stronger ones describes the same stretch and is dropped; one
 * that only touches a stronger one at an edge is trimmed to the part that is
 * still its own, so seconds are never counted twice. If a stronger segment
 * sits inside a weaker one, the weaker one keeps both sides (same uuid).
 */
export function resolveOverlaps(segments: readonly SkipSegment[]): SkipSegment[] {
  const accepted: SkipSegment[] = [];
  for (const cand of [...segments].sort(better)) {
    const length = cand.endSec - cand.startSec;
    if (length <= 0) continue;
    const taken = [...accepted].sort((a, b) => a.startSec - b.startSec);
    const pieces = subtract(cand.startSec, cand.endSec, taken);
    const free = pieces.reduce((sum, [s, e]) => sum + (e - s), 0);
    if (free / length <= 0.5) continue;
    for (const [s, e] of pieces) if (e - s > 0.01) accepted.push({ ...cand, startSec: s, endSec: e });
  }
  return accepted.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

/** Total seconds covered by the union of the spans. */
export function unionSeconds(spans: readonly { startSec: number; endSec: number }[]): number {
  const sorted = spans.filter((s) => s.endSec > s.startSec).sort((a, b) => a.startSec - b.startSec);
  let total = 0;
  let curStart = Number.NEGATIVE_INFINITY;
  let curEnd = Number.NEGATIVE_INFINITY;
  for (const s of sorted) {
    if (s.startSec > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s.startSec;
      curEnd = s.endSec;
    } else {
      curEnd = Math.max(curEnd, s.endSec);
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

function emptyLookup(ref: VideoRef, looked: boolean): SkipLookup {
  return { videoId: ref.id, segments: [], chapters: [], looked };
}

function isAbort(err: unknown, name: string): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === name;
}

const UPSTREAM_HINT =
  'SponsorBlock is unreachable or failing. The transcript itself is unaffected: retry later, point SPONSORBLOCK_API_URL at a mirror, or set VID2CONTEXT_SPONSORBLOCK=0 to stop lookups.';

/**
 * SponsorBlock segments for a YouTube video. Other platforms (and
 * VID2CONTEXT_SPONSORBLOCK=0) give an empty result without a request; a 404
 * from the API means the video has no segments and is also an empty result.
 */
export async function getSkipSegments(ref: VideoRef, ctx: Ctx, opts: SkipOptions = {}): Promise<SkipLookup> {
  if (ref.platform !== 'youtube' || ref.kind !== 'video') return emptyLookup(ref, false);
  if (!sponsorBlockEnabled(ctx)) {
    ctx.log.debug('SponsorBlock lookups are off (VID2CONTEXT_SPONSORBLOCK=0)');
    return emptyLookup(ref, false);
  }
  const categories = opts.categories ? parseCategories(opts.categories) : defaultCategories(ctx);
  if (categories.length === 0) return emptyLookup(ref, false);
  const minVotes = opts.minVotes ?? 0;
  const url = await skipSegmentsUrl(ctx, ref.nativeId, categories);

  let res: Response;
  try {
    res = await fetchWithTimeout(ctx, url, { headers: { accept: 'application/json' } }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    if (isAbort(err, 'TimeoutError')) {
      throw new Vid2ContextError('timeout', `SponsorBlock did not answer within ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms.`, {
        hint: UPSTREAM_HINT,
        cause: err,
      });
    }
    throw new Vid2ContextError('upstream', `SponsorBlock request failed: ${err instanceof Error ? err.message : String(err)}`, {
      hint: UPSTREAM_HINT,
      cause: err,
    });
  }

  if (res.status === 404) {
    await res.body?.cancel();
    return emptyLookup(ref, true);
  }
  if (!res.ok) {
    const e = await errorFromResponse(res, 'SponsorBlock');
    if (e.code === 'rate-limited') {
      throw new Vid2ContextError('rate-limited', e.message, {
        status: e.status,
        retryAfterSec: e.retryAfterSec,
        hint: 'SponsorBlock is rate limiting this IP. Wait a minute, or set VID2CONTEXT_SPONSORBLOCK=0 to stop lookups.',
      });
    }
    throw new Vid2ContextError('upstream', e.message, { status: e.status, retryAfterSec: e.retryAfterSec, hint: UPSTREAM_HINT });
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new Vid2ContextError('upstream', 'SponsorBlock answered with something that is not JSON.', {
      hint: UPSTREAM_HINT,
      cause: err,
    });
  }
  if (!Array.isArray(body)) {
    throw new Vid2ContextError('upstream', 'SponsorBlock answered with an unexpected shape (expected a list of videos).', {
      hint: UPSTREAM_HINT,
    });
  }

  const entry = (body as { videoID?: unknown; segments?: unknown }[]).find((v) => v?.videoID === ref.nativeId);
  if (!entry || !Array.isArray(entry.segments)) return emptyLookup(ref, true);

  const wanted = new Set<string>(categories);
  const kept = (entry.segments as RawSegment[])
    .map(toSkipSegment)
    .filter((s): s is SkipSegment => s !== undefined)
    .filter((s) => wanted.has(s.category))
    .filter((s) => s.votes >= 0 && (s.votes >= minVotes || s.locked === true));

  const best = (list: SkipSegment[]): SkipSegment | undefined => [...list].sort(better)[0];
  const lookup: SkipLookup = {
    videoId: ref.id,
    segments: resolveOverlaps(kept.filter((s) => s.actionType === 'skip' || s.actionType === 'mute')),
    chapters: kept.filter((s) => s.actionType === 'chapter').sort((a, b) => a.startSec - b.startSec),
    looked: true,
  };
  const highlight = best(kept.filter((s) => s.actionType === 'poi'));
  if (highlight) lookup.highlight = highlight;
  const full = best(kept.filter((s) => s.actionType === 'full'));
  if (full) lookup.fullVideo = full;
  return lookup;
}
