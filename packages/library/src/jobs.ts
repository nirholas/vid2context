/**
 * Collection ingest and refresh as background jobs on @vid2context/jobs.
 *
 *   ingest   { collectionId, inputs: string[], limit? }  add videos or lists now
 *   refresh  { collectionId, limit? }                     re-expand the sources and ingest new items
 *
 * Both report `progress` ({ done, total, message }) and one `item` event per
 * video, and finish with `{ collection, summary }`. Both are idempotent, so a
 * job retried after a crash only fetches what was not saved yet.
 *
 * libraryRoutes registers these kinds on the queue it is given. A separate
 * runner (Cloud Tasks, Cloudflare Queues consumer) calls registerLibraryJobs
 * itself with the same KvStore.
 */
import { type Collection, type Ctx, hasKv, type KvStore, MemoryKv, type Storage } from '@vid2context/core';
import type { JobHandler, JobQueue } from '@vid2context/jobs';
import { createLibrary, type ItemOutcome, type LibraryDeps, type RefreshSummary } from './library.ts';
import { bad } from './util.ts';

export const INGEST_KIND = 'ingest';
export const REFRESH_KIND = 'refresh';

export interface IngestJobInput {
  collectionId: string;
  inputs: string[];
  limit?: number;
}

export interface RefreshJobInput {
  collectionId: string;
  limit?: number;
}

export interface CollectionJobResult {
  collection: Collection;
  summary: RefreshSummary;
}

export interface LibraryJobOptions {
  /** Watch lists and seen sets, or a factory. Default: the job's storage when it implements KvStore, else one process-wide MemoryKv. */
  kv?: KvStore | ((ctx: Ctx, storage: Storage) => Promise<KvStore>);
  library?: Pick<LibraryDeps, 'webhook' | 'leaseTtlSec' | 'now'>;
}

function readInput(input: unknown, needsInputs: boolean): IngestJobInput {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (typeof o.collectionId !== 'string' || !o.collectionId) {
    throw bad('The job input needs a collectionId.', 'Queue collection jobs through POST /collections/:id/items or /refresh.');
  }
  const inputs = Array.isArray(o.inputs) ? o.inputs.filter((x): x is string => typeof x === 'string') : [];
  if (needsInputs && inputs.length === 0) throw bad('The ingest job needs inputs.', 'Pass {"inputs": ["<video or list URL>"]}.');
  const limit = typeof o.limit === 'number' && Number.isInteger(o.limit) && o.limit > 0 ? o.limit : undefined;
  return { collectionId: o.collectionId, inputs, ...(limit ? { limit } : {}) };
}

/** Register the `ingest` and `refresh` kinds on a queue. */
export function registerLibraryJobs(queue: Pick<JobQueue, 'registerKind'>, opts: LibraryJobOptions = {}): void {
  const fallbackKv = new MemoryKv();
  const kvFor = async (ctx: Ctx, storage: Storage): Promise<KvStore> =>
    typeof opts.kv === 'function' ? opts.kv(ctx, storage) : (opts.kv ?? (hasKv(storage) ? storage : fallbackKv));

  const handler =
    (kind: typeof INGEST_KIND | typeof REFRESH_KIND): JobHandler =>
    async ({ input, progress, item, registry, storage, ctx }) => {
      const job = readInput(input, kind === INGEST_KIND);
      const lib = createLibrary({ registry, storage, ctx, kv: await kvFor(ctx, storage), ...opts.library });
      const ingestOpts = {
        ...(job.limit ? { limit: job.limit } : {}),
        onProgress: progress,
        onItem: (e: ItemOutcome) =>
          item({ id: e.id, outcome: e.outcome, ...(e.title ? { title: e.title } : {}), ...(e.error ? { error: e.error } : {}) }),
      };
      const summary =
        kind === INGEST_KIND
          ? await lib.addVideos(job.collectionId, job.inputs, ingestOpts)
          : await lib.refresh(job.collectionId, ingestOpts);
      await lib.flush();
      const result: CollectionJobResult = { collection: await lib.getCollection(job.collectionId), summary };
      return result;
    };

  queue.registerKind(INGEST_KIND, handler(INGEST_KIND));
  queue.registerKind(REFRESH_KIND, handler(REFRESH_KIND));
}
