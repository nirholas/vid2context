/**
 * Server-side downloads as jobs. `POST /downloads` returns at once; the job
 * runs in the background under its own concurrency limit, reports progress
 * through `GET /downloads/:id`, and its file is served by
 * `GET /downloads/:id/file` until it expires (VID2CONTEXT_DOWNLOAD_TTL_MIN).
 *
 * Jobs live in this process's memory and their files in a private temp
 * directory; both are gone after a restart, which is the point: a server
 * should not accumulate media. Job ids are random UUIDs, so one caller
 * cannot guess another's job.
 */
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type Ctx, Vid2ContextError } from '@vid2context/core';
import type { DownloadRequest } from '../options.ts';
import { downloadPolicy } from '../policy.ts';
import type { DownloadedFile, Downloader, DownloadJob, DownloadManager, JobFile, JobStatus } from '../types.ts';

export interface ManagerOptions {
  downloader: Downloader;
  /** Parent directory for job files. Default: a new directory under the OS temp dir. */
  dir?: string;
  /** How often expired files are swept, in ms. Default 60 s. */
  sweepMs?: number;
}

interface Entry {
  job: DownloadJob;
  ctx: Ctx;
  abort: AbortController;
  dir?: string;
  path?: string;
  ttlMin: number;
}

export function createDownloadManager(options: ManagerOptions): DownloadManager {
  const { downloader } = options;
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  let running = 0;
  let root: Promise<string> | undefined;
  let closed = false;

  const rootDir = () => {
    root ??= options.dir
      ? mkdir(options.dir, { recursive: true }).then(() => options.dir as string)
      : mkdtemp(join(tmpdir(), 'vid2context-downloads-'));
    return root;
  };

  const now = () => new Date().toISOString();
  const touch = (e: Entry, patch: Partial<DownloadJob>) => {
    e.job = { ...e.job, ...patch, updatedAt: now() };
  };

  async function discard(e: Entry): Promise<void> {
    if (e.dir) await rm(e.dir, { recursive: true, force: true });
    e.dir = undefined;
    e.path = undefined;
  }

  const sweep = setInterval(() => {
    const t = Date.now();
    for (const [id, e] of entries) {
      if (e.job.expiresAt && Date.parse(e.job.expiresAt) <= t) {
        entries.delete(id);
        void discard(e);
      }
    }
  }, options.sweepMs ?? 60_000);
  sweep.unref?.();

  function pump(): void {
    while (!closed && queue.length > 0) {
      const next = entries.get(queue[0] as string);
      if (!next) {
        queue.shift();
        continue;
      }
      if (running >= downloadPolicy(next.ctx.env).concurrency) return;
      queue.shift();
      running++;
      void runJob(next).finally(() => {
        running--;
        pump();
      });
    }
  }

  // Read through a function: remove() can cancel the job while a download is awaited.
  const statusOf = (e: Entry): JobStatus => e.job.status;

  async function runJob(e: Entry): Promise<void> {
    if (statusOf(e) !== 'queued') return;
    touch(e, { status: 'running', progress: { phase: 'preparing', downloadedBytes: 0 } });
    try {
      e.dir = await mkdtemp(join(await rootDir(), 'job-'));
      const ctx: Ctx = { ...e.ctx, signal: e.abort.signal };
      let last = 0;
      const file: DownloadedFile = await downloader.download(e.job.request, ctx, {
        dir: e.dir,
        onProgress: (progress) => {
          // Progress lines arrive many times a second; keeping the latest is enough.
          const t = Date.now();
          if (progress.phase !== 'finished' && progress.phase === e.job.progress.phase && t - last < 250) return;
          last = t;
          touch(e, { progress });
        },
      });
      if (statusOf(e) === 'canceled') {
        await discard(e);
        return;
      }
      e.path = file.path;
      const { path: _path, ...publicFile } = file;
      touch(e, {
        status: 'done',
        file: publicFile,
        progress: { phase: 'finished', percent: 100, downloadedBytes: file.bytes, totalBytes: file.bytes },
        expiresAt: new Date(Date.now() + e.ttlMin * 60_000).toISOString(),
      });
    } catch (err) {
      await discard(e);
      if (statusOf(e) === 'canceled') return;
      const v = err instanceof Vid2ContextError ? err : undefined;
      touch(e, {
        status: 'error',
        error: {
          code: v?.code ?? 'upstream',
          message: err instanceof Error ? err.message : String(err),
          ...(v?.hint ? { hint: v.hint } : {}),
        },
        // Failed jobs stay visible for a while so the caller can read why.
        expiresAt: new Date(Date.now() + e.ttlMin * 60_000).toISOString(),
      });
    }
  }

  return {
    downloader,

    create(req: DownloadRequest, ctx: Ctx): DownloadJob {
      if (closed) throw new Vid2ContextError('unavailable', 'The server is shutting down.', { hint: 'Retry in a moment.' });
      const policy = downloadPolicy(ctx.env);
      const active = [...entries.values()].filter((e) => e.job.status === 'queued' || e.job.status === 'running').length;
      if (entries.size >= policy.maxJobs || active >= policy.maxJobs) {
        throw new Vid2ContextError('rate-limited', `This server already holds ${entries.size} downloads.`, {
          hint: 'Wait for some to finish or expire, delete finished ones (DELETE /downloads/:id), or raise VID2CONTEXT_MAX_DOWNLOAD_JOBS.',
          retryAfterSec: 30,
        });
      }
      const t = now();
      // The job outlives the request, so it gets its own signal instead of the request's.
      const { signal: _requestSignal, ...base } = ctx;
      const e: Entry = {
        job: {
          id: crypto.randomUUID(),
          status: 'queued',
          request: req,
          progress: { phase: 'queued', downloadedBytes: 0 },
          createdAt: t,
          updatedAt: t,
        },
        ctx: base as Ctx,
        abort: new AbortController(),
        ttlMin: policy.ttlMin,
      };
      entries.set(e.job.id, e);
      queue.push(e.job.id);
      pump();
      return e.job;
    },

    get(id) {
      return entries.get(id)?.job;
    },

    list() {
      return [...entries.values()].map((e) => e.job).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async remove(id) {
      const e = entries.get(id);
      if (!e) return false;
      if (e.job.status === 'queued' || e.job.status === 'running') {
        touch(e, { status: 'canceled' });
        e.abort.abort(new Vid2ContextError('bad-request', 'The download was canceled.'));
      }
      entries.delete(id);
      await discard(e);
      return true;
    },

    async open(id, range): Promise<JobFile | undefined> {
      const e = entries.get(id);
      if (e?.job.status !== 'done' || !e.path || !e.job.file) return undefined;
      let bytes: number;
      try {
        bytes = (await stat(e.path)).size;
      } catch {
        return undefined;
      }
      const opts = range ? { start: range.start, end: Math.min(range.end, bytes - 1) } : {};
      const node = createReadStream(e.path, opts);
      return {
        stream: Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>,
        bytes,
        filename: e.job.file.filename,
        mimeType: e.job.file.mimeType,
      };
    },

    async close() {
      closed = true;
      clearInterval(sweep);
      for (const e of entries.values()) {
        if (e.job.status === 'queued' || e.job.status === 'running') e.abort.abort();
      }
      await Promise.all([...entries.values()].map(discard));
      entries.clear();
      if (root && !options.dir) await rm(await root, { recursive: true, force: true });
    },
  };
}
