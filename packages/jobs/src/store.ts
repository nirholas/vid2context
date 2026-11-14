/**
 * Job persistence on a KvStore. Records live under `jobs:rec:<id>`; a cancel
 * request for a job running in another process lives under
 * `jobs:cancel:<id>`, a separate key so the runner's own record writes can
 * never overwrite it. Finished records expire through the KvStore TTL.
 */
import { type KvStore, Vid2ContextError } from '@vid2context/core';
import type { Job, JobRecord, JobStatus, ListJobsQuery } from './types.ts';

export const RECORD_PREFIX = 'jobs:rec:';
export const CANCEL_PREFIX = 'jobs:cancel:';

/** Events kept per record for stream catch-up. Older ones are dropped; the snapshot still carries the state. */
export const MAX_EVENTS = 500;

export const FINISHED: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'canceled']);

export function isFinished(status: JobStatus): boolean {
  return FINISHED.has(status);
}

/** Random, URL-safe and never sequential: `job_` plus 22 base64url characters (128 bits). */
export function newJobId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `job_${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

const ID_RE = /^job_[A-Za-z0-9_-]{22}$/;

export function isJobId(id: string): boolean {
  return ID_RE.test(id);
}

/** The public shape: input, options and bookkeeping stay private. */
export function publicJob(rec: JobRecord): Job {
  const job: Job = { id: rec.id, kind: rec.kind, status: rec.status, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
  if (rec.progress) job.progress = rec.progress;
  if (rec.result !== undefined) job.result = rec.result;
  if (rec.error) job.error = rec.error;
  return job;
}

export function newRecord(kind: string, input: unknown, options: Record<string, unknown>): JobRecord {
  const now = new Date().toISOString();
  return {
    id: newJobId(),
    kind,
    status: 'queued',
    input,
    options,
    attempts: 0,
    seq: 0,
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

interface ListCursor {
  /** KvStore cursor of the page being read (absent for the first page). */
  c?: string;
  /** Keys of that page already consumed. */
  s: number;
}

function encodeCursor(c: ListCursor): string {
  return btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(raw: string): ListCursor {
  try {
    const parsed = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))) as ListCursor;
    if (typeof parsed.s !== 'number' || (parsed.c !== undefined && typeof parsed.c !== 'string')) throw new Error('shape');
    return parsed;
  } catch {
    throw new Vid2ContextError('bad-request', 'Invalid jobs cursor.', {
      hint: 'Pass the cursor exactly as a previous list returned it.',
    });
  }
}

const PAGE = 100;

export class JobStore {
  constructor(
    readonly kv: KvStore,
    /** TTL for finished records, in seconds. */
    readonly ttlSec: number,
  ) {}

  get(id: string): Promise<JobRecord | null> {
    return this.kv.kvGet<JobRecord>(RECORD_PREFIX + id);
  }

  async put(rec: JobRecord): Promise<void> {
    await this.kv.kvSet(RECORD_PREFIX + rec.id, rec, isFinished(rec.status) ? { ttlSec: this.ttlSec } : {});
  }

  async requestCancel(id: string): Promise<void> {
    await this.kv.kvSet(CANCEL_PREFIX + id, true, { ttlSec: this.ttlSec });
  }

  async cancelRequested(id: string): Promise<boolean> {
    return (await this.kv.kvGet<boolean>(CANCEL_PREFIX + id)) === true;
  }

  /** Records matching the query, in key order, with an opaque cursor for the next page. */
  async list(query: ListJobsQuery = {}): Promise<{ records: JobRecord[]; cursor?: string }> {
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 50)), 500);
    let cur: ListCursor = query.cursor ? decodeCursor(query.cursor) : { s: 0 };
    const out: JobRecord[] = [];
    for (;;) {
      const page = await this.kv.kvList(RECORD_PREFIX, { limit: PAGE, ...(cur.c ? { cursor: cur.c } : {}) });
      for (let i = cur.s; i < page.keys.length; i++) {
        const rec = await this.kv.kvGet<JobRecord>(page.keys[i] as string);
        if (!rec) continue;
        if (query.status && rec.status !== query.status) continue;
        if (query.kind && rec.kind !== query.kind) continue;
        out.push(rec);
        if (out.length >= limit) {
          const more = i + 1 < page.keys.length || page.cursor !== undefined;
          const next: ListCursor =
            i + 1 < page.keys.length ? { ...(cur.c ? { c: cur.c } : {}), s: i + 1 } : { c: page.cursor, s: 0 };
          return more ? { records: out, cursor: encodeCursor(next) } : { records: out };
        }
      }
      if (!page.cursor) return { records: out };
      cur = { c: page.cursor, s: 0 };
    }
  }

  /** Every live record (used on start to resume work). */
  async all(): Promise<JobRecord[]> {
    const out: JobRecord[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.list({ limit: 500, ...(cursor ? { cursor } : {}) });
      out.push(...res.records);
      cursor = res.cursor;
    } while (cursor);
    return out;
  }
}
