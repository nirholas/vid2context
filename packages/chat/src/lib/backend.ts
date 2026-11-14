/**
 * The two ways the workspace answers. ServerBackend talks to the HTTP API
 * (POST /chat, GET /models, /context, /library, /collections, /uploads).
 * ClientBackend runs the LLM chain in this browser with the user's keys,
 * through the browser registry, and keeps attached transcripts in IndexedDB.
 * Components only see the Backend interface.
 */
import type { Collection, Env, LlmRung, VideoContext, VideoSummary } from '@vid2context/core';
import { createContext } from '@vid2context/core';
import { ApiClient, ApiError } from './api.ts';
import { localChat } from './local-engine.ts';
import { modelInfoFromRungs, toModelRows } from './models.ts';
import { contextTokens, tokensFromDuration } from './sources.ts';
import type { ChatStore } from './store.ts';
import type { AttachedContext, ChatApiRequest, ChatEvent, Conversation, ModelRow } from './types.ts';

export interface BackendFeatures {
  /** Paste a video URL the server resolves. */
  link: boolean;
  library: boolean;
  collections: boolean;
  uploads: boolean;
  /** Paste a timed transcript, or drop VideoContext JSON (client-only mode). */
  localFiles: boolean;
}

export interface Backend {
  readonly mode: 'server' | 'client';
  readonly features: BackendFeatures;
  listModels(): Promise<ModelRow[]>;
  chat(req: ChatApiRequest, conversation: Conversation, signal: AbortSignal): AsyncIterable<ChatEvent>;
  /** Resolve a video URL or id into an attached context (server mode). */
  attachInput(input: string, signal?: AbortSignal): Promise<AttachedContext>;
  attachLibraryItem(summary: VideoSummary): Promise<AttachedContext>;
  attachCollection(collectionId: string): Promise<AttachedContext>;
  attachUpload(file: File): Promise<AttachedContext>;
  /** Store contexts from a dropped file or a paste (client-only mode). */
  attachLocal(contexts: VideoContext[]): Promise<AttachedContext[]>;
  listLibrary(): Promise<VideoSummary[]>;
  listCollections(): Promise<Collection[]>;
  /** The full context of a cited video, for the source panel. */
  loadVideo(videoId: string, url?: string): Promise<VideoContext | undefined>;
}

export function attachedFromContext(c: VideoContext, kind: AttachedContext['kind'], input?: string): AttachedContext {
  return {
    key: kind === 'local' ? c.metadata.ref.id : (input ?? c.metadata.ref.id),
    kind,
    ...(input ? { input } : {}),
    videoId: c.metadata.ref.id,
    title: c.metadata.title,
    ...(c.metadata.thumbnailUrl ? { thumbnailUrl: c.metadata.thumbnailUrl } : {}),
    tokens: contextTokens(c),
    status: 'ready',
  };
}

function notInThisMode(what: string): never {
  throw new ApiError('bad-request', `${what} is not available in this mode.`, {
    hint: 'Switch modes in Settings, or attach context another way.',
  });
}

// ---------------------------------------------------------------- server

export class ServerBackend implements Backend {
  readonly mode = 'server' as const;
  readonly features: BackendFeatures;

  constructor(
    readonly api: ApiClient,
    private readonly store: ChatStore,
    routes: Set<string> | null,
  ) {
    // Without /openapi.json, GET routes are offered and fail with a clear error if missing; uploads need proof.
    this.features = {
      link: true,
      library: routes ? routes.has('GET /library') : true,
      collections: routes ? routes.has('GET /collections') : true,
      uploads: routes ? routes.has('POST /uploads') : false,
      localFiles: false,
    };
  }

  async listModels(): Promise<ModelRow[]> {
    return toModelRows(await this.api.models('llm'), 'server');
  }

  chat(req: ChatApiRequest, _conversation: Conversation, signal: AbortSignal): AsyncIterable<ChatEvent> {
    return this.api.chat(req, signal);
  }

  async attachInput(input: string, signal?: AbortSignal): Promise<AttachedContext> {
    const ctx = await this.api.context(input, signal);
    await this.store.putContext(ctx);
    return attachedFromContext(ctx, 'input', input);
  }

  async attachLibraryItem(summary: VideoSummary): Promise<AttachedContext> {
    const ctx = await this.api.libraryItem(summary.id);
    await this.store.putContext(ctx);
    return attachedFromContext(ctx, 'input', summary.ref.url ?? summary.id);
  }

  async attachCollection(collectionId: string): Promise<AttachedContext> {
    const c = await this.api.collection(collectionId);
    let tokens = 0;
    let known = false;
    for (const v of c.videos) {
      const t = tokensFromDuration(v.durationSec);
      if (t !== undefined) {
        tokens += t;
        known = true;
      }
    }
    return {
      key: `collection:${c.id}`,
      kind: 'collection',
      collectionId: c.id,
      title: c.name,
      videoCount: c.videos.length,
      ...(known ? { tokens, tokensApprox: true } : {}),
      status: 'ready',
    };
  }

  async attachUpload(file: File): Promise<AttachedContext> {
    const up = await this.api.upload(file, file.name);
    return { key: up.input, kind: 'upload', input: up.input, title: up.filename, status: 'ready' };
  }

  attachLocal(): Promise<AttachedContext[]> {
    return notInThisMode('Dropping transcript files');
  }

  async listLibrary(): Promise<VideoSummary[]> {
    return (await this.api.library(100)).items;
  }

  listCollections(): Promise<Collection[]> {
    return this.api.collections();
  }

  async loadVideo(videoId: string, url?: string): Promise<VideoContext | undefined> {
    const cached = await this.store.getContext(videoId);
    if (cached) return cached;
    try {
      const ctx = await this.api.libraryItem(videoId);
      await this.store.putContext(ctx);
      return ctx;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404 || !url) throw err;
    }
    const ctx = await this.api.context(url);
    await this.store.putContext(ctx);
    return ctx;
  }
}

/** Server request body for a conversation: its attached inputs and collection. */
export function requestContext(contexts: AttachedContext[]): ChatApiRequest['context'] | undefined {
  const inputs = contexts.filter((c) => c.status === 'ready' && c.input && c.kind !== 'collection').map((c) => c.input as string);
  const collection = contexts.find((c) => c.status === 'ready' && c.kind === 'collection');
  if (inputs.length === 0 && !collection) return undefined;
  return { ...(inputs.length ? { inputs } : {}), ...(collection?.collectionId ? { collectionId: collection.collectionId } : {}) };
}

// ---------------------------------------------------------------- client-only

export interface RungSource {
  llmRungs(env: Env): LlmRung[];
}

export class ClientBackend implements Backend {
  readonly mode = 'client' as const;
  readonly features: BackendFeatures = { link: false, library: false, collections: false, uploads: false, localFiles: true };

  constructor(
    private readonly registry: RungSource,
    private readonly env: Env,
    private readonly store: ChatStore,
    private readonly fetchFn?: typeof fetch,
  ) {}

  async listModels(): Promise<ModelRow[]> {
    return toModelRows(modelInfoFromRungs(this.registry.llmRungs(this.env), this.env), 'client', this.env);
  }

  async *chat(req: ChatApiRequest, conversation: Conversation, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const contexts: VideoContext[] = [];
    for (const a of conversation.contexts) {
      if (a.status !== 'ready' || !a.videoId) continue;
      const c = await this.store.getContext(a.videoId);
      if (c) contexts.push(c);
    }
    const ctx = createContext({ runtime: 'browser', env: this.env, signal, ...(this.fetchFn ? { fetch: this.fetchFn } : {}) });
    yield* localChat({ rungs: this.registry.llmRungs(this.env), ctx, request: req, contexts });
  }

  attachInput(): Promise<AttachedContext> {
    return notInThisMode('Fetching a video by URL');
  }
  attachLibraryItem(): Promise<AttachedContext> {
    return notInThisMode('The library');
  }
  attachCollection(): Promise<AttachedContext> {
    return notInThisMode('Collections');
  }
  attachUpload(): Promise<AttachedContext> {
    return notInThisMode('Uploading media');
  }

  async attachLocal(contexts: VideoContext[]): Promise<AttachedContext[]> {
    const out: AttachedContext[] = [];
    for (const c of contexts) {
      await this.store.putContext(c);
      out.push(attachedFromContext(c, 'local'));
    }
    return out;
  }

  async listLibrary(): Promise<VideoSummary[]> {
    return [];
  }
  async listCollections(): Promise<Collection[]> {
    return [];
  }

  loadVideo(videoId: string): Promise<VideoContext | undefined> {
    return this.store.getContext(videoId);
  }
}
