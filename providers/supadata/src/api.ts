/**
 * Supadata transcript API client: request building, polling, response and
 * error mapping. Every detail below comes from the official docs, read on
 * 2026-11-14:
 *
 *   [T]  https://docs.supadata.ai/get-transcript (endpoint, parameters, mode,
 *        202 job flow, polling every 1 s, job expiry, 206, pricing)
 *   [TO] https://docs.supadata.ai/api-reference/endpoint/transcript/transcript (OpenAPI for GET /transcript)
 *   [J]  https://docs.supadata.ai/api-reference/endpoint/transcript/transcript-get (OpenAPI for GET /transcript/{jobId}, JobResult)
 *   [A]  https://docs.supadata.ai/api-reference/introduction (base URL, x-api-key header, status codes, rate limit)
 *   [E]  https://docs.supadata.ai/errors/list and the per-code pages under https://docs.supadata.ai/errors/
 *
 * Runtime-neutral: only ctx.fetch, ctx.env and ctx.log; no node:* imports.
 */
import { type Ctx, type Env, fetchWithTimeout, type Segment, Vid2ContextError } from '@vid2context/core';

/** [A] "All requests contain the following base URL". Override with SUPADATA_BASE_URL (include the /v1). */
export const DEFAULT_BASE_URL = 'https://api.supadata.ai/v1';
/** Total time for one getCaptions call, first request and job polling included. Override with SUPADATA_MAX_WAIT_SEC. */
export const DEFAULT_MAX_WAIT_SEC = 120;
/** [T] Polling guidelines: "We recommend polling every 1 second". */
export const POLL_INTERVAL_MS = 1000;
/** Cap on one HTTP request. [T] says native transcripts resolve "at normal latency", so a request this long is a hang. */
export const REQUEST_TIMEOUT_MS = 60_000;

const KEY_HINT = 'Check SUPADATA_API_KEY. Free keys (100 credits a month) come from https://dash.supadata.ai.';

export interface SupadataSettings {
  key?: string;
  baseUrl: string;
  maxWaitMs: number;
}

export function settings(env: Env): SupadataSettings {
  const key = env.SUPADATA_API_KEY?.trim() || undefined;
  const baseUrl = (env.SUPADATA_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const sec = Number(env.SUPADATA_MAX_WAIT_SEC);
  const maxWaitMs = (Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_MAX_WAIT_SEC) * 1000;
  return { key, baseUrl, maxWaitMs };
}

/** [TO] TranscriptChunk: offset and duration are milliseconds; lang is the chunk's ISO 639-1 code. */
export interface SupadataChunk {
  text: string;
  offset: number;
  duration: number;
  lang?: string;
}

/** [T] HTTP 200 body with text=false: content is an array of chunks. */
export interface SupadataTranscript {
  content: SupadataChunk[] | string;
  lang?: string;
  availableLangs?: string[];
}

/** [E] "All errors follow a consistent JSON response format". */
export interface SupadataErrorBody {
  error: string;
  message?: string;
  details?: string;
  documentationUrl?: string;
}

/** [J] JobResult: status is required; content, lang and availableLangs arrive with "completed", error with "failed". */
export interface SupadataJob extends Partial<SupadataTranscript> {
  status: 'queued' | 'active' | 'completed' | 'failed';
  error?: SupadataErrorBody | null;
}

/**
 * GET {base}/transcript ([T] Specification). We always ask for:
 *   text=false   timed chunks, not plain text
 *   mode=native  "only fetch existing transcript": never AI generation, which costs
 *                2 credits a minute ([T] Pricing); speech-to-text is our own rungs' job
 * The video URL is rebuilt from the id so playlist and timestamp parameters never reach Supadata.
 */
export function transcriptUrl(baseUrl: string, videoId: string, language?: string): string {
  const params = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${videoId}` });
  if (language) params.set('lang', language);
  params.set('text', 'false');
  params.set('mode', 'native');
  return `${baseUrl}/transcript?${params}`;
}

/** [T] "Getting Job Results": GET {base}/transcript/{jobId}. */
export function jobUrl(baseUrl: string, jobId: string): string {
  return `${baseUrl}/transcript/${encodeURIComponent(jobId)}`;
}

/** [A] Authentication: the key goes in an x-api-key header. */
export function requestHeaders(key: string): Record<string, string> {
  return { 'x-api-key': key, accept: 'application/json' };
}

/** Chunks to segments. Text is kept exactly as sent; only chunks without text or a usable start time are dropped. */
export function toSegments(chunks: SupadataChunk[]): Segment[] {
  const out: Segment[] = [];
  for (const c of chunks) {
    if (!c || typeof c.text !== 'string' || c.text.trim() === '') continue;
    if (typeof c.offset !== 'number' || !Number.isFinite(c.offset) || c.offset < 0) continue;
    const dur = typeof c.duration === 'number' && Number.isFinite(c.duration) && c.duration > 0 ? c.duration : 0;
    out.push({ startSec: c.offset / 1000, endSec: (c.offset + dur) / 1000, text: c.text });
  }
  return out;
}

function redact(text: string, key: string | undefined): string {
  return key ? text.split(key).join('[redacted]') : text;
}

function isErrorBody(v: unknown): v is SupadataErrorBody {
  return typeof v === 'object' && v !== null && typeof (v as SupadataErrorBody).error === 'string';
}

/**
 * Map a Supadata error to a Vid2ContextError. Codes and statuses from [E]:
 * invalid-request 400, unauthorized 401, upgrade-required 402, forbidden 403,
 * not-found 404, limit-exceeded 429, internal-error 500, upstream-error 502.
 * (transcript-unavailable 206 is not an error here: getCaptions returns null.)
 *
 * The unauthorized page [E] says `details` can be "Invalid API Key: <key>", so
 * details are dropped for that code and the key is redacted from every message.
 */
export function mapError(
  status: number,
  body: SupadataErrorBody | undefined,
  opts: { key?: string; stage: 'transcript' | 'job'; retryAfterSec?: number },
): Vid2ContextError {
  const code = body?.error ?? '';
  const details = code === 'unauthorized' || status === 401 ? '' : (body?.details ?? body?.message ?? '');
  const message = redact(
    `Supadata ${opts.stage}: HTTP ${status}${code ? ` ${code}` : ''}${details ? `: ${details}` : ''}`,
    opts.key,
  ).slice(0, 300);
  const base = { status };

  if (code === 'unauthorized' || status === 401) return new Vid2ContextError('auth', message, { ...base, hint: KEY_HINT });
  if (code === 'upgrade-required' || status === 402) {
    return new Vid2ContextError('auth', message, {
      ...base,
      hint: 'This Supadata plan does not include the endpoint. Check the plan at https://dash.supadata.ai.',
    });
  }
  if (code === 'limit-exceeded' || status === 429) {
    // [E] limit-exceeded: `details` tells a per-second rate limit from the monthly quota.
    const quota = /usage limit/i.test(details);
    return new Vid2ContextError('rate-limited', message, {
      ...base,
      retryAfterSec: opts.retryAfterSec,
      hint: quota
        ? 'The Supadata monthly credits are used up. Wait for the next cycle or upgrade at https://dash.supadata.ai; other caption and speech-to-text rungs still run.'
        : 'Supadata rate limit (the free plan allows 1 request a second). Wait a moment and retry.',
    });
  }
  if (code === 'forbidden' || status === 403) {
    // [T] Video Accessibility: "403 Forbidden - Video requires authentication or is restricted".
    return new Vid2ContextError('unavailable', message, {
      ...base,
      hint: 'Supadata only reads public videos. For age-restricted or members-only videos, set YOUTUBE_COOKIE or use yt-dlp with cookies.',
    });
  }
  if (code === 'not-found' || status === 404) {
    if (opts.stage === 'job') {
      // [T] Polling guidelines: job results expire 1 hour after completion, then 404.
      return new Vid2ContextError('upstream', message, {
        ...base,
        hint: 'The Supadata job expired or is unknown. Retry the request.',
      });
    }
    // [T] Video Accessibility: "404 Not Found - Video does not exist or is private".
    return new Vid2ContextError('not-found', message, {
      ...base,
      hint: 'Check the video id: the video may be deleted or private.',
    });
  }
  if (code === 'invalid-request' || status === 400) {
    // [E] invalid-request also covers live streams and unsupported URLs.
    return new Vid2ContextError('upstream', message, {
      ...base,
      hint: 'Supadata rejected the request (live streams are refused). Other rungs run next.',
    });
  }
  return new Vid2ContextError('upstream', message, {
    ...base,
    retryAfterSec: opts.retryAfterSec,
    hint: 'Supadata had a server error. Retry later; https://status.supadata.ai shows outages.',
  });
}

async function readJson(res: Response, stage: 'transcript' | 'job'): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Vid2ContextError('upstream', `Supadata ${stage}: HTTP ${res.status} with a body that is not JSON.`, {
      status: res.status,
      cause,
    });
  }
}

function retryAfter(res: Response): number | undefined {
  // Not documented by Supadata; honoured when sent.
  const n = Number(res.headers.get('retry-after'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function timeoutError(maxWaitMs: number, cause?: unknown): Vid2ContextError {
  return new Vid2ContextError('timeout', `Supadata did not return a transcript within ${Math.round(maxWaitMs / 1000)} s.`, {
    hint: 'Raise SUPADATA_MAX_WAIT_SEC, or let the speech-to-text rungs transcribe the audio.',
    cause,
  });
}

async function request(url: string, s: SupadataSettings & { key: string }, deadline: number, ctx: Ctx): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError(s.maxWaitMs);
  try {
    return await fetchWithTimeout(ctx, url, { headers: requestHeaders(s.key) }, Math.min(remaining, REQUEST_TIMEOUT_MS));
  } catch (err) {
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? err;
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw timeoutError(s.maxWaitMs, err);
    throw new Vid2ContextError('upstream', `Supadata: request failed: ${redact(String(err), s.key).slice(0, 200)}`, {
      hint: 'Check the network connection or SUPADATA_BASE_URL.',
      cause: err,
    });
  }
}

/** Result of one transcript lookup: the transcript, or null when Supadata has none (206 transcript-unavailable). */
export type FetchResult = { transcript: SupadataTranscript; credits?: string } | null;

/**
 * Fetch the native transcript of one YouTube video, following the async job
 * flow when the API answers with a jobId. Bounded by SUPADATA_MAX_WAIT_SEC and ctx.signal.
 */
export async function fetchTranscript(videoId: string, language: string | undefined, ctx: Ctx): Promise<FetchResult> {
  const s = settings(ctx.env);
  const key = s.key;
  if (!key) return null;
  const withKey = { ...s, key };
  const deadline = Date.now() + s.maxWaitMs;

  const res = await request(transcriptUrl(s.baseUrl, videoId, language), withKey, deadline, ctx);
  // [T] Tracking Credit Usage: every response carries x-billable-requests.
  const credits = res.headers.get('x-billable-requests') ?? undefined;
  ctx.log.debug('supadata-captions: response', { videoId, status: res.status, credits });

  // [A] 206: "Transcript unavailable for this media". A 2xx, so check before res.ok.
  if (res.status === 206) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) {
    const body = await readJson(res, 'transcript').catch(() => undefined);
    throw mapError(res.status, isErrorBody(body) ? body : undefined, {
      key,
      stage: 'transcript',
      retryAfterSec: retryAfter(res),
    });
  }

  const body = await readJson(res, 'transcript');
  // [TO] 200 and 202 share the TranscriptOrJobId schema, so look for jobId on either.
  if (typeof body === 'object' && body !== null && typeof (body as { jobId?: unknown }).jobId === 'string') {
    const job = await pollJob((body as { jobId: string }).jobId, withKey, deadline, ctx);
    return job ? { transcript: job, credits } : null;
  }
  return { transcript: asTranscript(body, 'transcript'), credits };
}

async function pollJob(
  jobId: string,
  s: SupadataSettings & { key: string },
  deadline: number,
  ctx: Ctx,
): Promise<SupadataTranscript | null> {
  ctx.log.debug('supadata-captions: polling job', { jobId });
  for (;;) {
    const res = await request(jobUrl(s.baseUrl, jobId), s, deadline, ctx);
    if (!res.ok) {
      const body = await readJson(res, 'job').catch(() => undefined);
      throw mapError(res.status, isErrorBody(body) ? body : undefined, {
        key: s.key,
        stage: 'job',
        retryAfterSec: retryAfter(res),
      });
    }
    const job = (await readJson(res, 'job')) as SupadataJob;
    // [J] Job Status Values: queued, active, completed, failed.
    if (job?.status === 'completed') return asTranscript(job, 'job');
    if (job?.status === 'failed') {
      if (job.error?.error === 'transcript-unavailable') return null;
      throw mapError(res.status, job.error ?? undefined, { key: s.key, stage: 'job' });
    }
    if (job?.status !== 'queued' && job?.status !== 'active') {
      throw new Vid2ContextError(
        'upstream',
        `Supadata job: unexpected status ${JSON.stringify(job?.status ?? null).slice(0, 40)}.`,
      );
    }
    const wait = Math.min(POLL_INTERVAL_MS, deadline - Date.now());
    if (wait <= 0) throw timeoutError(s.maxWaitMs);
    try {
      await sleep(wait, ctx.signal);
    } catch (err) {
      throw ctx.signal?.reason ?? err;
    }
  }
}

function asTranscript(body: unknown, stage: 'transcript' | 'job'): SupadataTranscript {
  const content = (body as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) return body as SupadataTranscript;
  throw new Vid2ContextError(
    'upstream',
    `Supadata ${stage}: expected timed transcript chunks, got ${typeof content === 'string' ? 'plain text' : 'no content'}.`,
  );
}
