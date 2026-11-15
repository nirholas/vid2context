/**
 * Server-side toolkit tasks (captions, frames, clips, batches) as jobs, the
 * same way `createDownloadManager` runs downloads: they return at once, run
 * in the background under VID2CONTEXT_DOWNLOAD_CONCURRENCY, report progress
 * (and per-item status for batches), and their files are served until they
 * expire (VID2CONTEXT_DOWNLOAD_TTL_MIN). Ids are random UUIDs and paths never
 * leave the server. Canceling kills the child processes and waits for them
 * to exit before the job's folder is removed.
 */
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { type Ctx, Vid2ContextError } from '@vid2context/core';
import { downloadPolicy } from '../policy.ts';
import type { TaskJob, TaskQueue, Toolkit, ToolkitRequest } from '../toolkit.ts';
import type { JobFile } from '../types.ts';

interface Entry {
  job: TaskJob;
  ctx: Ctx;
  abort: AbortController;
  dir?: string;
  path?: string;
  itemPaths?: (string | undefined)[];
  ttlMin: number;
  running?: Promise<void>;
}

const STOP_GRACE_MS = 10_000;

export interface TaskQueueOptions {
  toolkit: Omit<Toolkit, 'jobs'>;
  /** Parent directory for task files. Default: a new directory under the OS temp dir. */
  dir?: string;
  sweepMs?: number;
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

export function createTaskQueue(options: TaskQueueOptions): TaskQueue {
  const { toolkit } = options;
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  let running = 0;
  let root: Promise<string> | undefined;
  let closed = false;
  const rootDir = () => {
    root ??= options.dir ? Promise.resolve(options.dir) : mkdtemp(join(tmpdir(), 'vid2context-tasks-'));
    return root;
  };
  const now = () => new Date().toISOString();
  const touch = (e: Entry, patch: Partial<TaskJob>) => {
    e.job = { ...e.job, ...patch, updatedAt: now() };
  };
  async function discard(e: Entry): Promise<void> {
    if (e.dir) await rm(e.dir, { recursive: true, force: true });
    e.dir = undefined;
    e.path = undefined;
    e.itemPaths = undefined;
  }
  async function settled(e: Entry): Promise<void> {
    if (!e.running) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      e.running.catch(() => undefined),
      new Promise<void>((r) => {
        timer = setTimeout(r, STOP_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
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
      next.running = runTask(next).finally(() => {
        running--;
        pump();
      });
    }
  }

  const statusOf = (e: Entry) => e.job.status;

  async function runTask(e: Entry): Promise<void> {
    if (statusOf(e) !== 'queued') return;
    touch(e, { status: 'running', progress: { phase: 'preparing', downloadedBytes: 0 } });
    try {
      e.dir = await mkdtemp(join(await rootDir(), 'task-'));
      const ctx: Ctx = { ...e.ctx, signal: e.abort.signal };
      let last = 0;
      const result = await toolkit.run(e.job.request, ctx, {
        dir: e.dir,
        onProgress: (progress) => {
          const t = Date.now();
          if (progress.phase !== 'finished' && progress.phase === e.job.progress.phase && t - last < 250) return;
          last = t;
          touch(e, { progress });
        },
        onItems: (items) => touch(e, { items }),
      });
      if (statusOf(e) === 'canceled') {
        await discard(e);
        return;
      }
      if (result.file) e.path = result.file.path;
      if (result.itemPaths) e.itemPaths = result.itemPaths;
      const patch: Partial<TaskJob> = {
        status: 'done',
        progress: {
          phase: 'finished',
          percent: 100,
          downloadedBytes: result.file?.bytes ?? 0,
          ...(result.file ? { totalBytes: result.file.bytes } : {}),
        },
        expiresAt: new Date(Date.now() + e.ttlMin * 60_000).toISOString(),
      };
      if (result.file) {
        const { path: _p, ...pub } = result.file;
        patch.file = pub;
      }
      if (result.items) patch.items = result.items;
      if (result.warnings?.length) patch.warnings = result.warnings;
      touch(e, patch);
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
        expiresAt: new Date(Date.now() + e.ttlMin * 60_000).toISOString(),
      });
    }
  }

  return {
    create(req: ToolkitRequest, ctx: Ctx): TaskJob {
      if (closed) throw new Vid2ContextError('unavailable', 'The server is shutting down.', { hint: 'Retry in a moment.' });
      const policy = downloadPolicy(ctx.env);
      if (entries.size >= policy.maxJobs) {
        throw new Vid2ContextError('rate-limited', `This server already holds ${entries.size} tasks.`, {
          hint: 'Wait for some to finish or expire, delete finished ones (DELETE /downloads/:id), or raise VID2CONTEXT_MAX_DOWNLOAD_JOBS.',
          retryAfterSec: 30,
        });
      }
      const t = now();
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

    get: (id) => entries.get(id)?.job,

    list: () => [...entries.values()].map((e) => e.job).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),

    async remove(id) {
      const e = entries.get(id);
      if (!e) return false;
      if (e.job.status === 'queued' || e.job.status === 'running') {
        touch(e, { status: 'canceled' });
        e.abort.abort(new Vid2ContextError('bad-request', 'The task was canceled.'));
      }
      entries.delete(id);
      await settled(e);
      await discard(e);
      return true;
    },

    async open(id, range, item): Promise<JobFile | undefined> {
      const e = entries.get(id);
      if (e?.job.status !== 'done') return undefined;
      const path = item === undefined ? e.path : e.itemPaths?.[item];
      if (!path) return undefined;
      let bytes: number;
      try {
        bytes = (await stat(path)).size;
      } catch {
        return undefined;
      }
      const meta =
        item === undefined
          ? { filename: e.job.file?.filename ?? basename(path), mimeType: e.job.file?.mimeType ?? 'application/octet-stream' }
          : {
              filename: e.job.items?.[item]?.file?.filename ?? basename(path),
              mimeType:
                e.job.items?.[item]?.file?.mimeType ?? MIME_BY_EXT[path.split('.').pop() ?? ''] ?? 'application/octet-stream',
            };
      const node = createReadStream(path, range ? { start: range.start, end: Math.min(range.end, bytes - 1) } : {});
      return { stream: Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>, bytes, ...meta };
    },

    async close() {
      closed = true;
      clearInterval(sweep);
      for (const e of entries.values()) {
        if (e.job.status === 'queued' || e.job.status === 'running') e.abort.abort();
      }
      await Promise.all([...entries.values()].map(settled));
      await Promise.all([...entries.values()].map(discard));
      entries.clear();
      if (root && !options.dir) await rm(await root, { recursive: true, force: true });
    },
  };
}
