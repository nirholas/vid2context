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
  type Env,
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
import { parseRequestKeys, REQUEST_KEYS_HEADER, requestKeyNames } from './request-keys.ts';
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
  /**
   * The Ctx for a request, created once and reused by every middleware, route
   * and sub-app. Provider keys sent in X-Vid2Context-Keys (when accepted) are
   * merged into its env for this request only.
   */
  ctxFor(req: Request): Ctx;
  /** Provider key names this server accepts per request; empty when VID2CONTEXT_REQUEST_KEYS=0. */
  requestKeyNames(req: Request): string[];
  /** Names of the keys this request brought (never the values). */
  userKeys(ctx: Ctx): string[];
  /** The error for a malformed X-Vid2Context-Keys header, if this request sent one. */
  requestKeysError(req: Request): Vid2ContextError | undefined;
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
  /** The server's own env for a request's Ctx, without keys the request brought. */
  const baseEnvOf = new WeakMap<Ctx, Env>();
  const userKeysOf = new WeakMap<Ctx, string[]>();
  const keysErrorFor = new WeakMap<Request, Vid2ContextError>();
  let acceptedNames: { list: string[]; set: Set<string> } | undefined;
  const accepted = () => {
    if (!acceptedNames) {
      const list = requestKeyNames(registry);
      acceptedNames = { list, set: new Set(list) };
    }
    return acceptedNames;
  };
  /** The registry for this request: metered against the caller's plan in hosted mode. */
  const registryFor = (ctx: Ctx): Registry => hostedFor.get(ctx)?.registry(registry) ?? registry;

  const config = (req: Request): ServerConfig => {
    let cfg = configCache.get(req);
    if (!cfg) {
      // Settings come from the server's own env, never from keys a request brought.
      cfg = serverConfig(baseEnv(ctxFor(req)));
      configCache.set(req, cfg);
    }
    return cfg;
  };

  const ctxFor = (req: Request): Ctx => {
    let ctx = ctxCache.get(req);
    if (ctx) return ctx;
    const base = makeCtx(req);
    const cfg = serverConfig(base.env);
    const signals = [AbortSignal.timeout(cfg.requestTimeoutMs), base.signal].filter((s): s is AbortSignal => Boolean(s));
    let env = base.env;
    let names: string[] = [];
    const header = cfg.requestKeys ? req.headers.get(REQUEST_KEYS_HEADER) : null;
    if (header) {
      // Never throw here: ctxFor also runs in onError. The requestKeys middleware reports a bad header.
      try {
        const keys = parseRequestKeys(header, accepted().set);
        names = Object.keys(keys).sort();
        if (names.length > 0) env = { ...base.env, ...keys };
      } catch (err) {
        if (err instanceof Vid2ContextError) keysErrorFor.set(req, err);
        else throw err;
      }
    }
    ctx = { ...base, env, signal: AbortSignal.any(signals) };
    baseEnvOf.set(ctx, base.env);
    userKeysOf.set(ctx, names);
    ctxCache.set(req, ctx);
    return ctx;
  };

  const baseEnv = (ctx: Ctx): Env => baseEnvOf.get(ctx) ?? ctx.env;
  const userKeys = (ctx: Ctx): string[] => userKeysOf.get(ctx) ?? [];

  const storage = (ctx: Ctx): Promise<Storage> => {
    // Opened once with the server's env and this request's fetch, but not its signal or any keys
    // the request brought: the storage outlives the request and is shared by every caller.
    const base: Ctx = { ...ctx, env: baseEnv(ctx), signal: undefined };
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

  /**
   * Requests that brought their own keys never join (or are joined by) a run
   * that used other credentials: each gets a run of its own.
   */
  let ownKeysRun = 0;
  const keysTag = (ctx: Ctx): string => (userKeys(ctx).length > 0 ? `own-keys-${++ownKeysRun}` : '');

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
    return shared(`upload\u0000${entry.sha256}\u0000${langKey}\u0000${who}\u0000${keysTag(ctx)}`, ctx, async (runCtx) => {
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
      keysTag(ctx),
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
    // Each video runs under shared()'s own signal, so stop handing out new ones once the
    // client is gone, the deadline passed or one video failed; otherwise up to 100 runs
    // would continue for a response nobody will read.
    let failed = false;
    const worker = async () => {
      while (next < jobs.length && !failed) {
        ctx.signal?.throwIfAborted();
        const i = next++;
        try {
          results[i] = await (jobs[i] as () => Promise<VideoContext>)();
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, jobs.length) }, worker));
    return results;
  };

  const alias = (next: Request, prev: Request): void => {
    ctxCache.set(next, ctxFor(prev));
    configCache.set(next, config(prev));
    const keysError = keysErrorFor.get(prev);
    if (keysError) keysErrorFor.set(next, keysError);
  };

  return {
    registry,
    uploads,
    ctxFor,
    requestKeyNames: (req) => (config(req).requestKeys ? accepted().list : []),
    userKeys,
    requestKeysError: (req) => keysErrorFor.get(req),
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
