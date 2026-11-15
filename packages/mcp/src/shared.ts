/**
 * Helpers every vid2context MCP tool shares: the error body, the transcript
 * header, per-call contexts, progress notifications and the one storage
 * backend all tools (and the packages wired in from elsewhere) read and write.
 */
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  attemptsOf,
  type Ctx,
  formatTimestamp,
  MemoryStorage,
  type RecoveryContext,
  type Registry,
  type Storage,
  suggestRecoveries,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

/** A structured result: pretty-printed JSON text for every client plus `structuredContent` for clients that read it. */
export function structured(value: object, prefix = ''): ToolResult {
  return {
    content: [{ type: 'text', text: prefix + JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/**
 * The contract's error body: `{ error, message, hint?, attempts, recovery }`
 * as a tool result with isError. `recovery` lists, best first, what the
 * agent can do next (core recovery.ts), so a failed call is never a dead end.
 */
export function toolError(err: unknown, recovery: RecoveryContext = { surface: 'mcp' }): ToolResult {
  const e = err instanceof Vid2ContextError ? err : undefined;
  const payload = {
    error: e?.code ?? 'error',
    message: err instanceof Error ? err.message : String(err),
    ...(e?.hint ? { hint: e.hint } : {}),
    attempts: attemptsOf(err),
    recovery: suggestRecoveries(err, recovery, attemptsOf(err)),
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

/** A short header so the agent knows which video a transcript came from and how it was produced. */
export function contextHeader(c: VideoContext): string {
  const m = c.metadata;
  const lines = [
    `Title: ${m.title}`,
    m.channel ? `Channel: ${m.channel.name}` : undefined,
    m.ref.url ? `URL: ${m.ref.url}` : undefined,
    m.durationSec ? `Duration: ${formatTimestamp(m.durationSec)}` : undefined,
    `Transcript: ${c.transcript.origin}, ${c.transcript.language}${c.transcript.translated ? ', machine-translated' : ''} (${c.transcript.producer})`,
    m.chapters.length > 0
      ? `Chapters: ${m.chapters.map((ch) => `${formatTimestamp(ch.startSec)} ${ch.title}`).join(' | ')}`
      : undefined,
  ];
  return `${lines.filter(Boolean).join('\n')}\n\n`;
}

/** A per-call Ctx: a shallow copy carrying the call's abort signal, so nothing per-request lives on the server. */
export function callCtx(ctx: Ctx, signal?: AbortSignal): Ctx {
  return { ...ctx, signal: signal ?? ctx.signal };
}

/** Send a progress notification when the client asked for them (sent a progress token). Never fails the call. */
export async function progress(extra: Extra, done: number, total: number, message: string): Promise<void> {
  const token = extra._meta?.progressToken;
  if (token === undefined) return;
  try {
    await extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress: done, total, message },
    });
  } catch {
    // A client that hung up mid-call is not an error for the tool itself.
  }
}

/**
 * One Storage for the whole server, opened on first use: the registry's
 * enabled backend (SQLite, D1, Postgres) or, when none is configured,
 * MemoryStorage (this process only). Methods delegate to the opened backend,
 * so tools and wired packages that need a Storage value synchronously still
 * share the same data.
 */
export class LazyStorage implements Storage {
  private opened?: Promise<Storage>;
  private name = 'memory';

  constructor(
    private readonly registry: Registry,
    private readonly ctx: Ctx,
  ) {}

  get backend(): string {
    return this.name;
  }

  open(): Promise<Storage> {
    this.opened ??= this.registry
      .openStorage(this.ctx)
      .catch((err: unknown) => {
        this.ctx.log.warn('storage backend failed to open, using memory storage', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
      .then((s) => {
        const store = s ?? new MemoryStorage();
        this.name = store.backend;
        return store;
      });
    return this.opened;
  }

  getContext: Storage['getContext'] = async (id) => (await this.open()).getContext(id);
  putContext: Storage['putContext'] = async (c) => (await this.open()).putContext(c);
  deleteContext: Storage['deleteContext'] = async (id) => (await this.open()).deleteContext(id);
  listContexts: Storage['listContexts'] = async (o) => (await this.open()).listContexts(o);
  createCollection: Storage['createCollection'] = async (i) => (await this.open()).createCollection(i);
  getCollection: Storage['getCollection'] = async (id) => (await this.open()).getCollection(id);
  listCollections: Storage['listCollections'] = async () => (await this.open()).listCollections();
  updateCollection: Storage['updateCollection'] = async (id, p) => (await this.open()).updateCollection(id, p);
  addToCollection: Storage['addToCollection'] = async (id, v) => (await this.open()).addToCollection(id, v);
  removeFromCollection: Storage['removeFromCollection'] = async (id, v) => (await this.open()).removeFromCollection(id, v);
  deleteCollection: Storage['deleteCollection'] = async (id) => (await this.open()).deleteCollection(id);
  search: Storage['search'] = async (q) => (await this.open()).search(q);
}

/** Find a collection by id, then by exact name (case-insensitive). Throws not-found with a recovery hint. */
export async function findCollection(storage: Storage, idOrName: string) {
  const byId = await storage.getCollection(idOrName);
  if (byId) return byId;
  const q = idOrName.trim().toLowerCase();
  const byName = (await storage.listCollections()).find((c) => c.name.toLowerCase() === q);
  if (byName) return byName;
  throw new Vid2ContextError('not-found', `Collection not found: ${idOrName}`, {
    hint: 'Call list_collections to see valid ids, or create_collection to make one.',
  });
}
