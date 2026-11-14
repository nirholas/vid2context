/**
 * What every route needs: the registry, one Ctx per request (with the request
 * timeout folded into its abort signal), the library storage, a KvStore, the
 * upload store, and context loading with single-flight (identical concurrent
 * requests share one pipeline run).
 */

import type { HostedRequest } from '@vid2context/accounts/http';
import {
  type Attempt,
  attemptsOf,
  type Ctx,
  checkInput,
  enforceInputPolicy,
  expandInput,
  getVideoContext,
  hasKv,
  type KvStore,
  MemoryKv,
  MemoryStorage,
  type Registry,
  type Storage,
  type TranscriptMode,
  transcribe,
  Vid2ContextError,
  type VideoContext,
  type VideoMetadata,
} from '@vid2context/core';
import { type ServerConfig, serverConfig } from './config.ts';
import {
  isUploadInput,
  type UploadBackend,
  type UploadEntry,
  UploadStore,
  uploadAudio,
  uploadMetadata,
  uploadRef,
} from './uploads.ts';

/** How many uploads at the size cap this process keeps in memory at once; older ones are dropped first. */
export const UPLOADS_HELD_AT_CAP = 4;

export interface LoadOptions {
  mode?: TranscriptMode;
  language?: string;
  /** Fetch comments too: true for the source default, or a limit. */
  comments?: boolean | number;
  /** Ignore the library copy and rebuild. */
  refresh?: boolean;
}

/** Most videos one POST /pack or POST /bundle may combine. Larger sets belong in a collection and a job. */
export const MAX_BATCH_VIDEOS = 100;

/** Videos loaded at the same time for batch routes. */
const BATCH_CONCURRENCY = 4;

export interface Services {
  registry: Registry;
  uploads: UploadStore;
  /** The Ctx for a request, created once and reused by every middleware, route and sub-app. */
  ctxFor(req: Request): Ctx;
  /** Make `next` share the Ctx and config of `prev` (for middleware that re-wraps the Request). */
  alias(next: Request, prev: Request): void;
  config(req: Request): ServerConfig;
  storage(ctx: Ctx): Promise<Storage>;
  kv(ctx: Ctx): Promise<KvStore>;
  /** Throw `unsupported-input` for inputs public mode refuses (local paths, file://, private hosts). */
  checkInput(input: string, ctx: Ctx): void;
  loadContext(input: string, opts: LoadOptions, ctx: Ctx): Promise<VideoContext>;
  loadMetadata(input: string, ctx: Ctx): Promise<VideoMetadata>;
  /** Where uploads persist for this request: the library storage (R2 blobs when it has them) and the KvStore. */
  uploadBackend(ctx: Ctx): Promise<UploadBackend>;
  /** The live upload for an `upload:<sha256>` input. */
  getUpload(input: string, ctx: Ctx): Promise<UploadEntry>;
  /** Hosted mode: meter this request's pipeline work against the caller's plan and use the shared cache. */
  setHosted(req: Request, hosted: HostedRequest): void;
  /** Contexts for a batch: inputs (playlists expanded) and/or a collection's saved videos. */
  loadBatch(sel: { inputs?: string[]; collectionId?: string }, opts: LoadOptions, ctx: Ctx): Promise<VideoContext[]>;
}

/**
 * `openStorage` overrides how the library storage is opened (the Node entry
 * shares one Storage between the app and the jobs queue). Default: the
 * registry's enabled storage provider, else a process-wide MemoryStorage.
 */
export function createServices(
  registry: Registry,
  makeCtx: (req: Request) => Ctx,
  openStorage?: (ctx: Ctx) => Promise<Storage>,
): Services {
  const ctxCache = new WeakMap<Request, Ctx>();
  const configCache = new WeakMap<Request, ServerConfig>();
  const memory = new MemoryStorage();
  const memoryKv = new MemoryKv();
  let storagePromise: Promise<Storage> | undefined;
  const uploads = new UploadStore();
  const inflight = new Map<string, Promise<VideoContext>>();
  const hostedFor = new WeakMap<Ctx, HostedRequest>();
  /** The registry for this request: metered against the caller's plan in hosted mode. */
  const registryFor = (ctx: Ctx): Registry => hostedFor.get(ctx)?.registry(registry) ?? registry;

  const config = (req: Request): ServerConfig => {
    let cfg = configCache.get(req);
    if (!cfg) {
      cfg = serverConfig(ctxFor(req).env);
      configCache.set(req, cfg);
    }
    return cfg;
  };

  const ctxFor = (req: Request): Ctx => {
    let ctx = ctxCache.get(req);
    if (ctx) return ctx;
    const base = makeCtx(req);
    const timeoutMs = serverConfig(base.env).requestTimeoutMs;
    const signals = [AbortSignal.timeout(timeoutMs), base.signal].filter((s): s is AbortSignal => Boolean(s));
    ctx = { ...base, signal: AbortSignal.any(signals) };
    ctxCache.set(req, ctx);
    return ctx;
  };

  const storage = (ctx: Ctx): Promise<Storage> => {
    // Opened once with this request's env and fetch, but not its signal: the storage outlives the request.
    const base: Ctx = { ...ctx, signal: undefined };
    storagePromise ??= (openStorage ? openStorage(base) : registry.openStorage(base)).then(
      (s) => s ?? memory,
      (err) => {
        storagePromise = undefined;
        throw err;
      },
    );
    return storagePromise;
  };

  const kv = async (ctx: Ctx): Promise<KvStore> => {
    const s = await storage(ctx);
    return hasKv(s) ? s : memoryKv;
  };

  const check = (input: string, ctx: Ctx): void => {
    const refused = checkInput(input, ctx.env);
    if (refused) throw refused;
  };

  /**
   * Run `work` once for all identical concurrent requests. The shared run
   * gets its own timeout signal instead of the first caller's, so one client
   * disconnecting does not fail the others.
   */
  const shared = (key: string, ctx: Ctx, work: (runCtx: Ctx) => Promise<VideoContext>): Promise<VideoContext> => {
    const running = inflight.get(key);
    if (running) return running;
    const runCtx: Ctx = { ...ctx, signal: AbortSignal.timeout(serverConfig(ctx.env).requestTimeoutMs) };
    const p = work(runCtx).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  const uploadBackend = async (ctx: Ctx): Promise<UploadBackend> => ({ storage: await storage(ctx), kv: await kv(ctx) });

  const getUpload = async (input: string, ctx: Ctx): Promise<UploadEntry> => {
    const cfg = serverConfig(ctx.env);
    return uploads.get(input, {
      ttlMin: cfg.uploadTtlMin,
      maxTotalBytes: UPLOADS_HELD_AT_CAP * cfg.maxUploadBytes,
      backend: await uploadBackend(ctx),
    });
  };

  const loadUpload = async (input: string, opts: LoadOptions, ctx: Ctx): Promise<VideoContext> => {
    const entry = await getUpload(input, ctx);
    const mode = opts.mode ?? 'auto';
    if (mode === 'captions' || mode === 'video') {
      throw new Vid2ContextError(
        'unsupported-input',
        `Uploads are transcribed from their audio; mode "${mode}" does not apply.`,
        {
          hint: 'Use mode "auto" or "stt" (or leave mode out) for uploaded files.',
        },
      );
    }
    const langKey = opts.language ?? '';
    const backend = await uploadBackend(ctx);
    const cached = await uploads.getContext(entry, langKey, backend);
    if (cached) return cached;
    const who = hostedFor.get(ctx)?.principal ?? '';
    return shared(`upload\u0000${entry.sha256}\u0000${langKey}\u0000${who}`, ctx, async (runCtx) => {
      const ref = uploadRef(entry);
      const attempts: Attempt[] = [{ id: 'uploads', stage: 'resolve', outcome: 'ok', detail: ref.id }];
      try {
        const res = await transcribe(registryFor(ctx), ref, uploadAudio(entry), { stt: { language: opts.language } }, runCtx);
        const context: VideoContext = {
          metadata: uploadMetadata(entry),
          transcript: res.transcript,
          attempts: [...attempts, ...res.attempts],
        };
        await uploads.putContext(entry, langKey, context, backend);
        return context;
      } catch (err) {
        attempts.push(...attemptsOf(err));
        const tooLarge = attempts.some((a) => a.reason === 'too-large');
        throw Object.assign(
          new Vid2ContextError('no-transcript', `Could not transcribe ${entry.filename}.`, {
            hint: tooLarge
              ? 'The file is larger than every speech-to-text service accepts. Reduce it to compressed audio first (for example 64 kbit/s mono MP3 or Opus); the web app does this in the browser.'
              : 'Check `attempts` for why each speech-to-text rung failed. Adding a free key (GROQ_API_KEY) or a local whisper.cpp adds rungs.',
          }),
          { attempts },
        );
      }
    });
  };

  const loadContext = async (input: string, opts: LoadOptions, ctx: Ctx): Promise<VideoContext> => {
    check(input, ctx);
    if (isUploadInput(input)) return loadUpload(input, opts, ctx);
    const hosted = hostedFor.get(ctx);
    const base = await storage(ctx);
    // Hosted mode: public videos come from (and go to) the shared cache, and work is metered per caller.
    const store = hosted ? hosted.storage(base, { mode: opts.mode, language: opts.language, refresh: opts.refresh }) : base;
    const key = JSON.stringify([
      input.trim(),
      opts.mode ?? 'auto',
      opts.language ?? '',
      opts.comments ?? false,
      opts.refresh ?? false,
      hosted?.principal ?? '',
    ]);
    return shared(key, ctx, (runCtx) =>
      getVideoContext(
        registryFor(ctx),
        input,
        { mode: opts.mode, language: opts.language, comments: opts.comments, refresh: opts.refresh, storage: store },
        runCtx,
      ),
    );
  };

  const loadMetadata = async (input: string, ctx: Ctx): Promise<VideoMetadata> => {
    check(input, ctx);
    if (isUploadInput(input)) return uploadMetadata(await getUpload(input, ctx));
    await enforceInputPolicy(input, ctx);
    const { source, ref } = registry.resolve(input);
    return source.getMetadata(ref, ctx);
  };

  const loadBatch = async (
    sel: { inputs?: string[]; collectionId?: string },
    opts: LoadOptions,
    ctx: Ctx,
  ): Promise<VideoContext[]> => {
    const jobs: (() => Promise<VideoContext>)[] = [];
    const tooMany = () =>
      new Vid2ContextError('too-large', `More than ${MAX_BATCH_VIDEOS} videos in one request.`, {
        hint: 'Split the request, or add the videos to a collection and work with it through jobs.',
      });
    if (sel.collectionId) {
      const store = await storage(ctx);
      const collection = await store.getCollection(sel.collectionId);
      if (!collection) {
        throw new Vid2ContextError('not-found', `Collection not found: ${sel.collectionId}`, {
          hint: 'List collections with GET /api/v1/collections to see valid ids.',
        });
      }
      for (const id of collection.videoIds) {
        jobs.push(async () => (await store.getContext(id)) ?? loadContext(id, opts, ctx));
      }
    }
    for (const input of sel.inputs ?? []) {
      check(input, ctx);
      if (isUploadInput(input)) {
        jobs.push(() => loadContext(input, opts, ctx));
        continue;
      }
      const refs = await expandInput(registry, input, ctx, { limit: MAX_BATCH_VIDEOS + 1 });
      for (const ref of refs) jobs.push(() => loadContext(ref.kind === 'video' && ref.url ? ref.url : ref.input, opts, ctx));
      if (jobs.length > MAX_BATCH_VIDEOS) throw tooMany();
    }
    if (jobs.length > MAX_BATCH_VIDEOS) throw tooMany();
    if (jobs.length === 0) {
      throw new Vid2ContextError('bad-request', 'No videos to work on.', {
        hint: 'Pass "inputs" (video, playlist or channel URLs) or a "collectionId" that has videos.',
      });
    }
    const results: VideoContext[] = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await (jobs[i] as () => Promise<VideoContext>)();
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, jobs.length) }, worker));
    return results;
  };

  const alias = (next: Request, prev: Request): void => {
    ctxCache.set(next, ctxFor(prev));
    configCache.set(next, config(prev));
  };

  return {
    registry,
    uploads,
    ctxFor,
    alias,
    config,
    storage,
    kv,
    checkInput: check,
    loadContext,
    loadMetadata,
    uploadBackend,
    getUpload,
    setHosted: (req, hosted) => {
      hostedFor.set(ctxFor(req), hosted);
    },
    loadBatch,
  };
}
