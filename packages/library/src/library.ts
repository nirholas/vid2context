/**
 * Collections as living research libraries.
 *
 * A collection follows sources (playlists, channels, podcast feeds, pages).
 * `refresh` expands every source, ingests the items the collection has not
 * seen yet through the normal free-first pipeline, and records per-item
 * failures without stopping. Watch lists run refreshes on a schedule, and a
 * webhook hears about every new item.
 *
 * Small state lives in a KvStore (the storage backend when it implements
 * one, else process memory), under the `library:` namespace:
 *
 *   library:watch:<collectionId>    Schedule
 *   library:state:<collectionId>    { seenIds, lastCheckedAt, lastError, nextDueAt }
 *   library:pending:<collectionId>  video inputs waiting for the next refresh (from imports)
 *   library:lease:<collectionId>    a short-lived lock so two schedulers never refresh one collection at once
 */
import {
  type Collection,
  type Ctx,
  expandInput,
  getVideoContext,
  hasKv,
  type KvStore,
  limits,
  MemoryKv,
  type Registry,
  type Storage,
  summarize,
  Vid2ContextError,
  type VideoRef,
  type VideoSummary,
} from '@vid2context/core';
import { firstDueAt, nextDueAt, parseSchedule, type Schedule } from './schedule.ts';
import { bad, type ErrorInfo, eachLimit, errorInfo, randomToken } from './util.ts';
import { sendWebhook, type WebhookOptions, type WebhookResult, webhookPayload } from './webhook.ts';

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_DELAY_MS = 300;
export const DEFAULT_LEASE_TTL_SEC = 3600;
/** Seen ids kept per collection; the oldest drop off first. Keeps the KV value far below 1 MB. */
export const MAX_SEEN = 10_000;

const PREFIX = 'library:';
const watchKey = (id: string) => `${PREFIX}watch:${id}`;
const stateKey = (id: string) => `${PREFIX}state:${id}`;
const pendingKey = (id: string) => `${PREFIX}pending:${id}`;
const leaseKey = (id: string) => `${PREFIX}lease:${id}`;

/** Failures that will not change by retrying later. Other failures are retried on the next refresh. */
const PERMANENT = new Set(['not-found', 'unavailable', 'unsupported-input', 'bad-request']);

/** Matches the Job progress shape in docs/contracts/http-api.md. */
export interface Progress {
  done: number;
  total?: number;
  message?: string;
}

export interface IngestFailure {
  /** The video or source input that failed. */
  input: string;
  code: string;
  message: string;
  hint?: string;
  /** The failed step behind the error, for example the caption download YouTube answered with HTTP 429. */
  cause?: string;
}

export interface RefreshSummary {
  collectionId: string;
  /** Videos ingested and added to the collection in this run. */
  added: VideoSummary[];
  /** Items found that the collection already had or had seen before. */
  skipped: number;
  failed: IngestFailure[];
  /** New items left for the next run because of the item cap or an abort. */
  remaining: number;
  checkedAt: string;
}

export interface IngestOptions {
  /** Most new items to ingest this run. Capped by VID2CONTEXT_MAX_PLAYLIST_ITEMS (default 500). */
  limit?: number;
  /** Videos fetched at once. Default 3. */
  concurrency?: number;
  /** Pause between items on each worker, in ms. Default 300. */
  delayMs?: number;
  onProgress?: (p: Progress) => void;
  /** One call per video fetched, as it finishes (the jobs engine streams these as `item` events). */
  onItem?: (item: ItemOutcome) => void;
}

export interface ItemOutcome {
  /** Video id (`platform:nativeId`). */
  id: string;
  input: string;
  outcome: 'ok' | 'error';
  title?: string;
  error?: { code: string; message: string; hint?: string };
}

export interface RefreshOptions extends IngestOptions {
  /** The run's clock reading (checkedAt). Schedulers pass their `now`. */
  now?: Date;
}

export interface WatchState {
  seenIds: string[];
  lastCheckedAt?: string;
  lastError?: ErrorInfo | null;
  nextDueAt?: string;
}

export interface Watch {
  schedule: Schedule;
  state: WatchState;
}

export type CollectionDetail = Collection & {
  videos: VideoSummary[];
  /** Video inputs from an import, ingested on the next refresh. */
  pending: string[];
  watch: Watch | null;
};

export interface DueResult {
  collectionId: string;
  status: 'refreshed' | 'failed' | 'leased' | 'removed';
  summary?: RefreshSummary;
  error?: ErrorInfo;
}

/** The portable definition `exportCollection` writes and `importCollection` reads. No transcripts. */
export interface CollectionDefinition {
  format: 'vid2context.collection';
  version: 1;
  name: string;
  description?: string;
  sources: string[];
  /** Video inputs (canonical URLs) of the collection's videos. */
  videos: string[];
  schedule?: Schedule;
}

export interface LibraryDeps {
  registry: Registry;
  storage: Storage;
  ctx: Ctx;
  /** Watch lists, seen sets and leases. Default: the storage when it implements KvStore, else process memory. */
  kv?: KvStore;
  /** Clock for watch lists and checkedAt. Default: the system clock. */
  now?: () => Date;
  webhook?: WebhookOptions;
  /** Lease lifetime in seconds; a crashed refresh frees its collection after this. Default 3600. */
  leaseTtlSec?: number;
}

interface Candidate {
  ref: VideoRef;
  /** The input it came from: a source, a pending import entry or an addVideos input. */
  origin: string;
}

/** In-flight refreshes per storage, so one process never refreshes a collection twice at once. */
const inflight = new WeakMap<Storage, Map<string, Promise<RefreshSummary>>>();

function stringList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s.trim())) {
    throw bad(`${field} must be an array of non-empty strings.`, `Send ${field} as ["<url>", ...].`);
  }
  return v.map((s: string) => s.trim());
}

export class Library {
  readonly registry: Registry;
  readonly storage: Storage;
  readonly ctx: Ctx;
  readonly kv: KvStore;
  private readonly clock: () => Date;
  private readonly webhookOpts: WebhookOptions;
  private readonly leaseTtlSec: number;
  private readonly deliveries = new Set<Promise<WebhookResult>>();

  constructor(deps: LibraryDeps) {
    this.registry = deps.registry;
    this.storage = deps.storage;
    this.ctx = deps.ctx;
    this.kv = deps.kv ?? (hasKv(deps.storage) ? deps.storage : new MemoryKv());
    this.clock = deps.now ?? (() => new Date());
    this.webhookOpts = deps.webhook ?? {};
    this.leaseTtlSec = deps.leaseTtlSec ?? DEFAULT_LEASE_TTL_SEC;
  }

  /** The core limit VID2CONTEXT_MAX_PLAYLIST_ITEMS (default 500): items read per source and ingested per run. */
  get maxItems(): number {
    return limits(this.ctx.env).maxPlaylistItems;
  }

  // Collections

  async getCollection(id: string): Promise<Collection> {
    const c = await this.storage.getCollection(id);
    if (!c)
      throw new Vid2ContextError('not-found', `Collection not found: ${id}`, { hint: 'List collections to see valid ids.' });
    return c;
  }

  async createCollection(input: { name?: unknown; description?: unknown; sources?: unknown }): Promise<Collection> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw bad('A collection needs a name.', 'Send {"name": "G-Wagon"}.');
    if (input.description !== undefined && input.description !== null && typeof input.description !== 'string') {
      throw bad('description must be a string.', 'Send description as text, or leave it out.');
    }
    const sources = this.validSources(stringList(input.sources, 'sources'));
    return this.storage.createCollection({
      name,
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      sources,
    });
  }

  async updateCollection(id: string, patch: { name?: unknown; description?: unknown; sources?: unknown }): Promise<Collection> {
    await this.getCollection(id);
    const next: Partial<Pick<Collection, 'name' | 'description' | 'sources'>> = {};
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || !patch.name.trim())
        throw bad('name must be a non-empty string.', 'Send {"name": "..."}.');
      next.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      if (patch.description !== null && typeof patch.description !== 'string') {
        throw bad('description must be a string.', 'Send description as text, or null to clear it.');
      }
      next.description = patch.description ?? undefined;
    }
    if (patch.sources !== undefined) next.sources = this.validSources(stringList(patch.sources, 'sources'));
    return this.storage.updateCollection(id, next);
  }

  /** Deletes the collection and its watch list, seen set and pending inputs. Saved transcripts stay in the library. */
  async deleteCollection(id: string): Promise<void> {
    await this.storage.deleteCollection(id);
    for (const key of [watchKey(id), stateKey(id), pendingKey(id), leaseKey(id)]) await this.kv.kvDelete(key);
  }

  async listCollections(): Promise<Collection[]> {
    return this.storage.listCollections();
  }

  /** The collection with a summary of every saved video, its watch list and pending inputs. */
  async getCollectionDetail(id: string): Promise<CollectionDetail> {
    const c = await this.getCollection(id);
    const videos: VideoSummary[] = [];
    for (const vid of c.videoIds) {
      const context = await this.storage.getContext(vid);
      if (context) videos.push(summarize(context, context.transcript.createdAt));
    }
    return { ...c, videos, pending: (await this.kv.kvGet<string[]>(pendingKey(id))) ?? [], watch: await this.getWatch(id) };
  }

  // Sources

  /** Check that an input is a list a source can expand. Returns the trimmed input and its ref. */
  validateSource(input: string): { input: string; ref: VideoRef } {
    const trimmed = input.trim();
    if (!trimmed) throw bad('A source cannot be empty.', 'Pass a playlist, channel or podcast feed URL.');
    const { source, ref } = this.registry.resolve(trimmed);
    if (ref.kind === 'video') {
      throw bad(
        `"${trimmed.slice(0, 200)}" is a single video, not a list to follow.`,
        'Add single videos as items (POST /collections/:id/items, MCP add_to_collection); sources are playlists, channels and feeds.',
      );
    }
    if (!source.listItems) {
      throw new Vid2ContextError('unsupported-input', `${source.name} cannot list the items of a ${ref.kind} yet.`, {
        hint: 'Install a provider that can list it (yt-dlp covers most sites), or add the videos one by one.',
      });
    }
    return { input: trimmed, ref };
  }

  private validSources(inputs: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const input of inputs) {
      const v = this.validateSource(input);
      if (seen.has(v.ref.id)) continue;
      seen.add(v.ref.id);
      out.push(v.input);
    }
    return out;
  }

  private refIdOf(input: string): string | null {
    try {
      return this.registry.resolve(input).ref.id;
    } catch {
      return null;
    }
  }

  async addSource(collectionId: string, input: string): Promise<Collection> {
    const c = await this.getCollection(collectionId);
    const v = this.validateSource(input);
    if (c.sources.some((s) => s === v.input || this.refIdOf(s) === v.ref.id)) return c;
    return this.storage.updateCollection(collectionId, { sources: [...c.sources, v.input] });
  }

  /** Stops following a source (matched by input or by what it resolves to). Videos already ingested stay. */
  async removeSource(collectionId: string, input: string): Promise<Collection> {
    const c = await this.getCollection(collectionId);
    const target = this.refIdOf(input);
    const sources = c.sources.filter((s) => s !== input.trim() && (target === null || this.refIdOf(s) !== target));
    if (sources.length === c.sources.length) return c;
    return this.storage.updateCollection(collectionId, { sources });
  }

  // Ingest

  /**
   * Ingest videos or lists into a collection now. Lists are expanded; items
   * already in the collection are skipped. Unlike refresh, this ignores the
   * seen set, so it can bring back a video that was removed.
   */
  async addVideos(collectionId: string, inputs: string[], opts: IngestOptions = {}): Promise<RefreshSummary> {
    const c = await this.getCollection(collectionId);
    const clean = stringList(inputs, 'inputs');
    if (clean.length === 0) throw bad('Nothing to add.', 'Send {"inputs": ["<video or playlist URL>", ...]}.');
    const run = await this.collect(clean, new Set(c.videoIds), Math.min(opts.limit ?? this.maxItems, this.maxItems));
    const { added, failed, remaining } = await this.ingest(c.id, run.candidates, opts);
    await this.rememberSeen(c.id, added, undefined);
    return {
      collectionId: c.id,
      added,
      skipped: run.skipped,
      failed: [...run.failed, ...failed].map(({ origin: _, ...f }) => f),
      remaining: remaining + run.overflow,
      checkedAt: this.clock().toISOString(),
    };
  }

  /** Remove videos from a collection and mark them seen, so a refresh does not bring them back. */
  async removeVideos(collectionId: string, videoIds: string[]): Promise<Collection> {
    const ids = stringList(videoIds, 'videoIds');
    const c = await this.storage.removeFromCollection(collectionId, ids);
    const state = await this.readState(collectionId);
    await this.writeState(collectionId, { ...state, seenIds: mergeSeen(state.seenIds, ids) });
    return c;
  }

  /**
   * Expand every source (and pending imported inputs), ingest what the
   * collection has not seen, and report. Running it twice in a row adds
   * nothing the second time. One process never runs two refreshes of the
   * same collection at once: a second call joins the first.
   */
  refresh(collectionId: string, opts: RefreshOptions = {}): Promise<RefreshSummary> {
    let byId = inflight.get(this.storage);
    if (!byId) {
      byId = new Map();
      inflight.set(this.storage, byId);
    }
    const running = byId.get(collectionId);
    if (running) return running;
    const map = byId;
    const p = this.runRefresh(collectionId, opts).finally(() => map.delete(collectionId));
    map.set(collectionId, p);
    return p;
  }

  private async runRefresh(collectionId: string, opts: RefreshOptions): Promise<RefreshSummary> {
    const c = await this.getCollection(collectionId);
    const checkedAt = (opts.now ?? this.clock()).toISOString();
    const state = await this.readState(c.id);
    const pending = (await this.kv.kvGet<string[]>(pendingKey(c.id))) ?? [];
    const known = new Set([...c.videoIds, ...state.seenIds]);
    const cap = Math.min(opts.limit ?? this.maxItems, this.maxItems);
    const run = await this.collect([...pending, ...c.sources], known, cap);
    const { added, failed, remaining, notDone } = await this.ingest(c.id, run.candidates, opts);

    // Pending inputs stay only while they still have work: a retryable failure, or items left over.
    if (pending.length > 0) {
      const keep = new Set<string>([...notDone, ...run.overflowOrigins]);
      for (const f of [...run.failed, ...failed]) if (!PERMANENT.has(f.code)) keep.add(f.origin);
      const left = pending.filter((p) => keep.has(p));
      if (left.length > 0) await this.kv.kvSet(pendingKey(c.id), left);
      else await this.kv.kvDelete(pendingKey(c.id));
    }
    await this.rememberSeen(c.id, added, checkedAt);

    const summary: RefreshSummary = {
      collectionId: c.id,
      added,
      skipped: run.skipped,
      failed: [...run.failed, ...failed].map(({ origin: _, ...f }) => f),
      remaining: remaining + run.overflow,
      checkedAt,
    };
    if (added.length > 0) this.notify(c, added, checkedAt);
    return summary;
  }

  /** Expand inputs into new candidates (deduplicated, not in `known`), up to `cap`. */
  private async collect(inputs: string[], known: Set<string>, cap: number) {
    const candidates: Candidate[] = [];
    const failed: (IngestFailure & { origin: string })[] = [];
    const overflowOrigins = new Set<string>();
    const queued = new Set<string>();
    let skipped = 0;
    let overflow = 0;
    for (const input of inputs) {
      if (this.ctx.signal?.aborted) break;
      let refs: VideoRef[];
      try {
        refs = await expandInput(this.registry, input, this.ctx, { limit: this.maxItems });
      } catch (err) {
        failed.push({ input, origin: input, ...errorInfo(err) });
        this.ctx.log.warn('library: could not expand input', { input, ...errorInfo(err) });
        continue;
      }
      for (const ref of refs) {
        if (known.has(ref.id) || queued.has(ref.id)) {
          skipped++;
          continue;
        }
        queued.add(ref.id);
        if (candidates.length >= cap) {
          overflow++;
          overflowOrigins.add(input);
          continue;
        }
        candidates.push({ ref, origin: input });
      }
    }
    return { candidates, failed, skipped, overflow, overflowOrigins };
  }

  /** Fetch each candidate with bounded concurrency; add successes to the collection as they land. */
  private async ingest(collectionId: string, candidates: Candidate[], opts: IngestOptions) {
    const added: VideoSummary[] = [];
    const failed: (IngestFailure & { origin: string })[] = [];
    const notDone = new Set(candidates.map((c) => c.origin));
    const total = candidates.length;
    let done = 0;
    const progress = (message: string) => opts.onProgress?.({ done, total, message });
    progress(total === 0 ? 'No new items.' : `Ingesting ${total} new item${total === 1 ? '' : 's'}.`);
    const remainingOf = new Map<string, number>();
    for (const c of candidates) remainingOf.set(c.origin, (remainingOf.get(c.origin) ?? 0) + 1);

    await eachLimit(
      candidates,
      opts.concurrency ?? DEFAULT_CONCURRENCY,
      opts.delayMs ?? DEFAULT_DELAY_MS,
      this.ctx.signal,
      async ({ ref, origin }) => {
        const input = ref.url ?? ref.input;
        try {
          const context = await getVideoContext(this.registry, input, { storage: this.storage }, this.ctx);
          await this.storage.addToCollection(collectionId, [context.metadata.ref.id]);
          added.push(summarize(context, context.transcript.createdAt));
          done++;
          opts.onItem?.({ id: context.metadata.ref.id, input, outcome: 'ok', title: context.metadata.title });
          progress(`Added ${context.metadata.title}`);
        } catch (err) {
          const info = errorInfo(err);
          failed.push({ input, origin, ...info });
          done++;
          const error = { code: info.code, message: info.message, ...(info.hint ? { hint: info.hint } : {}) };
          opts.onItem?.({ id: ref.id, input, outcome: 'error', error });
          progress(`Failed ${input}: ${info.code}`);
        }
        const left = (remainingOf.get(origin) ?? 1) - 1;
        remainingOf.set(origin, left);
        if (left === 0) notDone.delete(origin);
      },
    );
    return { added, failed, remaining: total - done, notDone };
  }

  // Seen set and state

  private async readState(id: string): Promise<WatchState> {
    const s = await this.kv.kvGet<WatchState>(stateKey(id));
    return { seenIds: [], ...s };
  }

  private async writeState(id: string, state: WatchState): Promise<void> {
    await this.kv.kvSet(stateKey(id), state);
  }

  private async rememberSeen(id: string, added: VideoSummary[], checkedAt: string | undefined): Promise<void> {
    const state = await this.readState(id);
    await this.writeState(id, {
      ...state,
      seenIds: mergeSeen(
        state.seenIds,
        added.map((a) => a.id),
      ),
      ...(checkedAt ? { lastCheckedAt: checkedAt } : {}),
    });
  }

  // Watch lists

  async getWatch(id: string): Promise<Watch | null> {
    const schedule = await this.kv.kvGet<Schedule>(watchKey(id));
    if (!schedule) return null;
    return { schedule, state: await this.readState(id) };
  }

  /** Set or replace a collection's schedule. A schedule without `at` is due at once. */
  async setWatch(id: string, schedule: unknown): Promise<Watch> {
    await this.getCollection(id);
    const s = parseSchedule(schedule);
    await this.kv.kvSet(watchKey(id), s);
    const state = await this.readState(id);
    const next: WatchState = { ...state, nextDueAt: firstDueAt(s, this.clock()).toISOString() };
    await this.writeState(id, next);
    return { schedule: s, state: next };
  }

  async removeWatch(id: string): Promise<void> {
    await this.kv.kvDelete(watchKey(id));
    const state = await this.kv.kvGet<WatchState>(stateKey(id));
    if (state) {
      const { nextDueAt: _, ...rest } = state;
      await this.writeState(id, rest);
    }
  }

  /**
   * Refresh every enabled watch list whose time has come, one at a time.
   * Safe from any scheduler and from several processes at once: each
   * collection is taken under a KV lease, and a collection someone else
   * holds is reported as `leased` and left alone.
   */
  async runDue(now: Date = this.clock(), opts: Omit<RefreshOptions, 'now'> = {}): Promise<DueResult[]> {
    const results: DueResult[] = [];
    const prefix = `${PREFIX}watch:`;
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const page = await this.kv.kvList(prefix, { cursor, limit: 100 });
      ids.push(...page.keys.map((k) => k.slice(prefix.length)));
      cursor = page.cursor;
    } while (cursor);

    for (const id of ids) {
      if (this.ctx.signal?.aborted) break;
      const schedule = await this.kv.kvGet<Schedule>(watchKey(id));
      if (!schedule?.enabled) continue;
      const before = await this.readState(id);
      if (before.nextDueAt && Date.parse(before.nextDueAt) > now.getTime()) continue;

      const token = await this.acquireLease(id);
      if (!token) {
        results.push({ collectionId: id, status: 'leased' });
        continue;
      }
      try {
        const summary = await this.refresh(id, { ...opts, now });
        const state = await this.readState(id);
        await this.writeState(id, { ...state, lastError: null, nextDueAt: nextDueAt(schedule, now).toISOString() });
        results.push({ collectionId: id, status: 'refreshed', summary });
      } catch (err) {
        const info = errorInfo(err);
        if (info.code === 'not-found' && !(await this.storage.getCollection(id))) {
          await this.deleteCollection(id);
          results.push({ collectionId: id, status: 'removed', error: info });
        } else {
          const state = await this.readState(id);
          await this.writeState(id, {
            ...state,
            lastCheckedAt: now.toISOString(),
            lastError: info,
            nextDueAt: nextDueAt(schedule, now).toISOString(),
          });
          this.ctx.log.warn('library: scheduled refresh failed', { collection: id, ...info });
          results.push({ collectionId: id, status: 'failed', error: info });
        }
      } finally {
        await this.releaseLease(id, token);
      }
    }
    return results;
  }

  private async acquireLease(id: string): Promise<string | null> {
    const key = leaseKey(id);
    if (await this.kv.kvGet(key)) return null;
    const token = randomToken();
    await this.kv.kvSet(key, { token, at: new Date().toISOString() }, { ttlSec: this.leaseTtlSec });
    // Read back: when two callers raced past the check above, only the last writer keeps the lease.
    const held = await this.kv.kvGet<{ token: string }>(key);
    return held?.token === token ? token : null;
  }

  private async releaseLease(id: string, token: string): Promise<void> {
    const key = leaseKey(id);
    const held = await this.kv.kvGet<{ token: string }>(key);
    if (held?.token === token) await this.kv.kvDelete(key);
  }

  // Notifications

  private notify(c: Collection, added: VideoSummary[], checkedAt: string): void {
    const url = this.ctx.env.VID2CONTEXT_WEBHOOK_URL?.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      this.ctx.log.warn('library: VID2CONTEXT_WEBHOOK_URL is not an http(s) URL; no webhook sent');
      return;
    }
    const secret = this.ctx.env.VID2CONTEXT_WEBHOOK_SECRET || undefined;
    const p = sendWebhook(url, secret, webhookPayload(c, added, checkedAt), this.ctx, this.webhookOpts);
    this.deliveries.add(p);
    p.finally(() => this.deliveries.delete(p));
  }

  /** Wait for webhook deliveries still in flight (Workers: pass to waitUntil; tests and CLIs: await before exit). */
  async flush(): Promise<WebhookResult[]> {
    return Promise.all([...this.deliveries]);
  }

  // Import and export

  async exportCollection(id: string): Promise<CollectionDefinition> {
    const c = await this.getCollection(id);
    const videos: string[] = [];
    for (const vid of c.videoIds) {
      const ref = (await this.storage.getContext(vid))?.metadata.ref;
      if (ref) videos.push(ref.url ?? ref.input);
    }
    for (const p of (await this.kv.kvGet<string[]>(pendingKey(id))) ?? []) if (!videos.includes(p)) videos.push(p);
    const schedule = await this.kv.kvGet<Schedule>(watchKey(id));
    return {
      format: 'vid2context.collection',
      version: 1,
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      sources: c.sources,
      videos,
      ...(schedule ? { schedule } : {}),
    };
  }

  /**
   * Recreate a collection from an exported definition. Its videos are queued
   * and ingested by the next refresh; pass `refresh: true` to run it now.
   * Everything is validated before anything is created.
   */
  async importCollection(
    json: unknown,
    opts: RefreshOptions & { refresh?: boolean } = {},
  ): Promise<{ collection: Collection; summary?: RefreshSummary }> {
    const def = parseDefinition(json);
    const sources = this.validSources(def.sources);
    for (const v of def.videos) this.registry.resolve(v);
    const collection = await this.storage.createCollection({
      name: def.name,
      ...(def.description ? { description: def.description } : {}),
      sources,
    });
    if (def.videos.length > 0) await this.kv.kvSet(pendingKey(collection.id), [...new Set(def.videos)]);
    if (def.schedule) await this.setWatch(collection.id, def.schedule);
    if (!opts.refresh) return { collection };
    const summary = await this.refresh(collection.id, opts);
    return { collection: await this.getCollection(collection.id), summary };
  }
}

function mergeSeen(seen: string[], ids: string[]): string[] {
  if (ids.length === 0) return seen;
  const set = new Set(seen);
  const out = [...seen];
  for (const id of ids) {
    if (set.has(id)) continue;
    set.add(id);
    out.push(id);
  }
  return out.length > MAX_SEEN ? out.slice(out.length - MAX_SEEN) : out;
}

const DEFINITION_HINT =
  'Send the JSON that exportCollection or GET /collections/:id/export produced: {"format": "vid2context.collection", "version": 1, "name": "...", "sources": [...], "videos": [...]}.';

/** Validate an untrusted collection definition. */
export function parseDefinition(json: unknown): CollectionDefinition {
  let value = json;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw bad('The collection definition is not valid JSON.', DEFINITION_HINT);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw bad('The collection definition must be a JSON object.', DEFINITION_HINT);
  const o = value as Record<string, unknown>;
  if (o.format !== undefined && o.format !== 'vid2context.collection') {
    throw bad(`Unknown definition format "${String(o.format)}".`, DEFINITION_HINT);
  }
  if (o.version !== undefined && o.version !== 1) {
    throw bad(
      `Unsupported definition version ${String(o.version)}.`,
      'This vid2context reads version 1. Export again with a matching version.',
    );
  }
  if (typeof o.name !== 'string' || !o.name.trim()) throw bad('The definition needs a name.', DEFINITION_HINT);
  if (o.description !== undefined && typeof o.description !== 'string')
    throw bad('description must be a string.', DEFINITION_HINT);
  return {
    format: 'vid2context.collection',
    version: 1,
    name: o.name.trim(),
    ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
    sources: stringList(o.sources, 'sources'),
    videos: stringList(o.videos, 'videos'),
    ...(o.schedule !== undefined && o.schedule !== null ? { schedule: parseSchedule(o.schedule) } : {}),
  };
}

export function createLibrary(deps: LibraryDeps): Library {
  return new Library(deps);
}
