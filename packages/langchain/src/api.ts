/**
 * The slice of the vid2context HTTP API the loader needs (docs/contracts/http-api.md):
 * GET /api/v1/context and GET /api/v1/items, with the contract's error body parsed into a Vid2ContextError.
 */
import {
  type Attempt,
  type ErrorCode,
  type TranscriptMode,
  Vid2ContextError,
  type VideoContext,
  type VideoRef,
} from '@vid2context/core';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';

export interface ApiOptions {
  /** Server URL. Default http://127.0.0.1:8787 (a server you run with `npm run start:server`). A trailing /api/v1 is accepted. */
  baseUrl?: string;
  /** Sent as `Authorization: Bearer <key>` when set (servers with VID2CONTEXT_API_KEYS). */
  apiKey?: string;
  /** Fetch implementation. Default: the global fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

// Every core code, so an unknown server code (such as `internal`) can be told apart.
const CODES: Record<ErrorCode, true> = {
  'unsupported-input': true,
  'not-found': true,
  unavailable: true,
  'no-transcript': true,
  'no-provider': true,
  'all-rungs-failed': true,
  'rate-limited': true,
  auth: true,
  blocked: true,
  'too-large': true,
  timeout: true,
  upstream: true,
  'bad-request': true,
};

/** A failed API call: the server's code, message and hint, plus every provider and rung it tried. */
export class Vid2ContextApiError extends Vid2ContextError {
  readonly attempts: Attempt[];
  /** The code exactly as the server sent it (`internal` maps to `code: 'upstream'`). */
  readonly serverCode: string;

  constructor(
    serverCode: string,
    message: string,
    opts: { hint?: string; status?: number; attempts?: Attempt[]; cause?: unknown },
  ) {
    super(serverCode in CODES ? (serverCode as ErrorCode) : 'upstream', message, opts);
    this.name = 'Vid2ContextApiError';
    this.serverCode = serverCode;
    this.attempts = opts.attempts ?? [];
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; hint?: unknown };
  attempts?: unknown;
}

/** Build the error for a non-2xx response from its body. */
export function errorFromBody(status: number, body: string): Vid2ContextApiError {
  let data: ErrorBody | undefined;
  try {
    data = JSON.parse(body) as ErrorBody;
  } catch {
    data = undefined;
  }
  const err = data?.error;
  if (err && typeof err.code === 'string') {
    return new Vid2ContextApiError(err.code, String(err.message ?? ''), {
      hint: typeof err.hint === 'string' ? err.hint : undefined,
      status,
      attempts: Array.isArray(data?.attempts) ? (data.attempts as Attempt[]) : [],
    });
  }
  const snippet = body.slice(0, 300).trim();
  return new Vid2ContextApiError('upstream', `HTTP ${status} without a vid2context error body${snippet ? `: ${snippet}` : ''}`, {
    hint: 'Check that the base URL points at a vid2context server (GET /api/v1/health should answer).',
    status,
  });
}

function apiBase(baseUrl: string | undefined): string {
  const url = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return url.endsWith('/api/v1') ? url : `${url}/api/v1`;
}

async function getJson<T>(path: string, query: URLSearchParams, opts: ApiOptions): Promise<T> {
  const endpoint = `${apiBase(opts.baseUrl)}${path}?${query}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const doFetch = opts.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(endpoint, { headers, signal: opts.signal });
  } catch (cause) {
    if (opts.signal?.aborted) throw cause;
    throw new Vid2ContextApiError('upstream', `Could not reach vid2context at ${apiBase(opts.baseUrl)}: ${String(cause)}`, {
      hint: 'Start the server with `npm run start:server` in the vid2context repo, or pass baseUrl.',
      cause,
    });
  }
  const body = await res.text();
  if (!res.ok) throw errorFromBody(res.status, body);
  try {
    return JSON.parse(body) as T;
  } catch (cause) {
    throw new Vid2ContextApiError(
      'upstream',
      `Expected JSON from ${endpoint}, got ${res.headers.get('content-type') ?? 'no content type'}.`,
      {
        hint: 'Check that the base URL points at a vid2context server.',
        status: res.status,
        cause,
      },
    );
  }
}

/** GET /api/v1/context: the full VideoContext for one video. */
export async function fetchContext(
  url: string,
  opts: ApiOptions & { mode?: TranscriptMode; lang?: string } = {},
): Promise<VideoContext> {
  const query = new URLSearchParams({ url });
  if (opts.mode) query.set('mode', opts.mode);
  if (opts.lang) query.set('lang', opts.lang);
  return getJson<VideoContext>('/context', query, opts);
}

/** GET /api/v1/items: a playlist, channel, feed or page expanded to video refs (a single video returns itself). */
export async function fetchItems(url: string, opts: ApiOptions & { limit?: number } = {}): Promise<VideoRef[]> {
  const query = new URLSearchParams({ url });
  if (opts.limit !== undefined) query.set('limit', String(opts.limit));
  const body = await getJson<{ items?: VideoRef[] }>('/items', query, opts);
  return body.items ?? [];
}
