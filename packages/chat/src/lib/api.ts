/**
 * Client for the vid2context HTTP API (docs/contracts/http-api.md and
 * docs/prompts/SHARED-CONTRACTS.md section 3). Plain fetch, injectable for
 * tests. Error bodies `{ error: { code, message, hint }, attempts }` become
 * ApiError, a Vid2ContextError that keeps the attempts so the UI can show
 * which rungs were tried.
 */
import type { Attempt, Collection, ErrorCode, Page, VideoContext, VideoSummary } from '@vid2context/core';
import { Vid2ContextError } from '@vid2context/core';
import { parseSse } from './sse.ts';
import type { ChatApiRequest, ChatErrorData, ChatEvent, ModelInfo, ModelKind } from './types.ts';

const KNOWN_CODES = new Set<string>([
  'unsupported-input',
  'not-found',
  'unavailable',
  'no-transcript',
  'no-provider',
  'all-rungs-failed',
  'rate-limited',
  'auth',
  'blocked',
  'too-large',
  'timeout',
  'upstream',
  'bad-request',
]);

export class ApiError extends Vid2ContextError {
  readonly attempts: Attempt[];
  /** The code exactly as the server sent it (may be 'internal', which is not a core ErrorCode). */
  readonly wireCode: string;
  /** True when the server answered with its "No route" 404: the route is not deployed on this server. */
  readonly missingRoute: boolean;

  constructor(
    wireCode: string,
    message: string,
    opts: { hint?: string; status?: number; attempts?: Attempt[]; missingRoute?: boolean } = {},
  ) {
    const code = (KNOWN_CODES.has(wireCode) ? wireCode : 'upstream') as ErrorCode;
    super(code, message, { hint: opts.hint, status: opts.status });
    this.name = 'ApiError';
    this.wireCode = wireCode;
    this.attempts = opts.attempts ?? [];
    this.missingRoute = opts.missingRoute ?? false;
  }

  toData(): ChatErrorData {
    return {
      code: this.wireCode,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.attempts.length ? { attempts: this.attempts } : {}),
    };
  }
}

/** Any thrown value as the data the error card renders. */
export function toErrorData(err: unknown): ChatErrorData {
  if (err instanceof ApiError) return err.toData();
  if (err instanceof Vid2ContextError) {
    const attempts = (err as Vid2ContextError & { attempts?: Attempt[] }).attempts;
    return { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...(attempts ? { attempts } : {}) };
  }
  if (err instanceof Error && err.name === 'AbortError') return { code: 'aborted', message: 'Stopped.' };
  if (err instanceof TypeError) {
    return {
      code: 'network',
      message: err.message || 'The request did not reach the server.',
      hint: 'Check that the vid2context server is running and that its address in Settings is right.',
    };
  }
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

export interface ApiClientOptions {
  /** Base URL including /api/v1, e.g. '/api/v1' or 'http://127.0.0.1:8787/api/v1'. */
  base: string;
  fetch?: typeof fetch;
  /** Sent as `Authorization: Bearer` when the server has VID2CONTEXT_API_KEYS set. */
  apiKey?: string;
}

export interface Health {
  ok: boolean;
  name: string;
  version: string;
  runtime: string;
}

export interface UploadResult {
  input: string;
  filename: string;
  bytes: number;
  mimeType: string;
  expiresAt: string;
}

export type CollectionWithVideos = Collection & { videos: VideoSummary[] };

export class ApiClient {
  readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiKey?: string;

  constructor(opts: ApiClientOptions) {
    this.base = opts.base.replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.apiKey = opts.apiKey || undefined;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...extra };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      ...init,
      headers: this.headers((init.headers as Record<string, string>) ?? {}),
    });
    if (!res.ok) throw await errorFromApi(res);
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    return (await res.json()) as T;
  }

  health(signal?: AbortSignal): Promise<Health> {
    return this.json<Health>('/health', { signal });
  }

  async models(kind: ModelKind = 'llm'): Promise<ModelInfo[]> {
    const body = await this.json<{ models: ModelInfo[] }>(`/models?kind=${kind}`);
    return body.models;
  }

  library(limit = 50, cursor?: string): Promise<Page<VideoSummary>> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    return this.json<Page<VideoSummary>>(`/library?${q}`);
  }

  libraryItem(id: string): Promise<VideoContext> {
    return this.json<VideoContext>(`/library/${encodeURIComponent(id)}`);
  }

  async collections(): Promise<Collection[]> {
    const body = await this.json<{ collections: Collection[] }>('/collections');
    return body.collections;
  }

  collection(id: string): Promise<CollectionWithVideos> {
    return this.json<CollectionWithVideos>(`/collections/${encodeURIComponent(id)}`);
  }

  context(input: string, signal?: AbortSignal): Promise<VideoContext> {
    return this.json<VideoContext>(`/context?url=${encodeURIComponent(input)}`, { signal });
  }

  async upload(file: Blob, filename: string): Promise<UploadResult> {
    const form = new FormData();
    form.append('file', file, filename);
    return this.json<UploadResult>('/uploads', { method: 'POST', body: form });
  }

  /** Paths in GET /openapi.json, when the server publishes it. Used to show only features this server has. */
  async routes(): Promise<Set<string> | null> {
    try {
      const doc = await this.json<{ paths?: Record<string, Record<string, unknown>> }>('/openapi.json');
      const out = new Set<string>();
      for (const [path, ops] of Object.entries(doc.paths ?? {})) {
        for (const method of Object.keys(ops)) out.add(`${method.toUpperCase()} ${path.replace(/^\/api\/v1/, '')}`);
      }
      return out;
    } catch {
      return null;
    }
  }

  /** POST /chat and yield its events. Ends after `done` or `error`; a stream that ends without either yields an error. */
  async *chat(req: ChatApiRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    const res = await this.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.body) throw new ApiError('upstream', 'The chat response had no body.', { status: res.status });
    yield* chatEventsFromSse(res.body, signal);
  }
}

/** Decode the chat SSE events of SHARED-CONTRACTS section 3. Unknown events are ignored. */
export async function* chatEventsFromSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  let finished = false;
  for await (const msg of parseSse(body, signal)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(msg.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (msg.event) {
      case 'meta':
        yield { type: 'meta', ...(data as Omit<Extract<ChatEvent, { type: 'meta' }>, 'type'>) };
        break;
      case 'reasoning':
        yield { type: 'reasoning', text: String(data.text ?? '') };
        break;
      case 'delta':
        yield { type: 'delta', text: String(data.text ?? '') };
        break;
      case 'done':
        finished = true;
        yield { type: 'done', ...(data as Omit<Extract<ChatEvent, { type: 'done' }>, 'type'>) };
        return;
      case 'error':
        finished = true;
        yield { type: 'error', ...(data as unknown as ChatErrorData) };
        return;
      default:
        break;
    }
  }
  if (!finished && !signal?.aborted) {
    yield {
      type: 'error',
      code: 'upstream',
      message: 'The answer stream ended before it finished.',
      hint: 'The connection dropped or the server stopped. Retry.',
    };
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; hint?: string };
  attempts?: Attempt[];
}

export async function errorFromApi(res: Response): Promise<ApiError> {
  let body: ErrorBody | null = null;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = null;
  }
  const code = body?.error?.code ?? (res.status === 401 ? 'auth' : res.status === 404 ? 'not-found' : 'upstream');
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  const missingRoute = res.status === 404 && /^No route for /.test(message);
  let hint = body?.error?.hint;
  if (!hint && res.status === 401) hint = 'This server needs an API key. Add it under Settings, Server API key.';
  if (!hint && missingRoute) hint = 'This server does not have that route yet. Update the server, or use client-only mode.';
  return new ApiError(code, message, {
    status: res.status,
    ...(hint ? { hint } : {}),
    ...(body?.attempts ? { attempts: body.attempts } : {}),
    missingRoute,
  });
}
