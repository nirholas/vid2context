/**
 * The vid2context HTTP API as the web app uses it. The server only returns
 * VideoContext JSON; formats, the .zip and agent text are made in the browser.
 */
import { type TranscriptMode, Vid2ContextError, type VideoContext, type VideoMetadata, type VideoRef } from '@vid2context/core';
import { type AppError, fromApiBody, isAbort, isApiErrorBody, withAttempts } from './errors.ts';

export const API_BASE_KEY = 'v2c.apiBase';

export const DEFAULT_API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) || '/api/v1';

/** True when built for a host with no API (GitHub Pages): VITE_CLIENT_ONLY=1. */
export const CLIENT_ONLY_BUILD: boolean = import.meta.env.VITE_CLIENT_ONLY === '1';

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function normalizeApiBase(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** The API base in use: the Settings override, else VITE_API_BASE, else /api/v1. */
export function apiBase(): string {
  const saved = readStorage(API_BASE_KEY);
  return normalizeApiBase(saved?.trim() ? saved : DEFAULT_API_BASE);
}

/** True when the user saved an API base in Settings. */
export function hasApiOverride(): boolean {
  return !!readStorage(API_BASE_KEY)?.trim();
}

/** Save an override, or clear it with an empty value. */
export function setApiBase(value: string): void {
  const v = normalizeApiBase(value);
  try {
    if (!v || v === normalizeApiBase(DEFAULT_API_BASE)) localStorage.removeItem(API_BASE_KEY);
    else localStorage.setItem(API_BASE_KEY, v);
  } catch {
    // Storage blocked (private mode): the override lasts only for this page.
  }
}

export function unreachable(base: string, cause?: unknown): AppError {
  return withAttempts(
    new Vid2ContextError('upstream', `Could not reach the vid2context API at ${base}.`, {
      hint: 'Start a server with `npm run start:server`, or set the API base in Settings to a server you can reach.',
      cause,
    }),
  );
}

function notAnApi(base: string, status: number): AppError {
  return withAttempts(
    new Vid2ContextError('upstream', `${base} answered with HTTP ${status} but not with vid2context JSON.`, {
      hint: 'The API base probably points at a static site. Set it in Settings to a running vid2context server (it ends in /api/v1).',
      status,
    }),
  );
}

/** Join the base and a path with query parameters, dropping empty values. */
export function apiUrl(path: string, params: Record<string, string | undefined> = {}, base = apiBase()): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, v);
  const qs = q.toString();
  return `${base}${path}${qs ? `?${qs}` : ''}`;
}

/** Per-call overrides: an abort signal, another base, or a fetch implementation (tests replay recorded responses). */
export interface CallOptions {
  signal?: AbortSignal;
  base?: string;
  fetch?: typeof fetch;
  /**
   * Provider keys sent with this request in X-Vid2Context-Keys, used by the
   * server for this request only (see lib/settings.ts keysForServer).
   */
  keys?: Record<string, string>;
}

/** Request headers for a call, with the keys header when the call carries keys. */
function callHeaders(call: CallOptions, json: boolean): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (json) h['content-type'] = 'application/json';
  if (call.keys && Object.keys(call.keys).length > 0) h['x-vid2context-keys'] = JSON.stringify(call.keys);
  return h;
}

/**
 * One JSON call with the app's error handling: unreachable servers, non-JSON
 * answers and API error bodies all become AppErrors with hints.
 */
export async function requestJson<T>(
  method: string,
  path: string,
  params: Record<string, string | undefined>,
  body: unknown,
  call: CallOptions = {},
): Promise<T> {
  const base = call.base ?? apiBase();
  const doFetch = call.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(apiUrl(path, params, base), {
      method,
      signal: call.signal,
      headers: callHeaders(call, body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw unreachable(base, err);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw notAnApi(base, res.status);
  }
  if (!res.ok) {
    if (isApiErrorBody(parsed)) throw fromApiBody(parsed, res.status);
    throw notAnApi(base, res.status);
  }
  return parsed as T;
}

function getJson<T>(path: string, params: Record<string, string | undefined>, call: CallOptions = {}): Promise<T> {
  return requestJson<T>('GET', path, params, undefined, call);
}

export interface RunOptions {
  mode?: TranscriptMode;
  lang?: string;
}

/** GET /context: the full VideoContext for one video. */
export function getContext(input: string, opts: RunOptions = {}, call: CallOptions = {}): Promise<VideoContext> {
  return getJson<VideoContext>('/context', { url: input, mode: opts.mode, lang: opts.lang }, call);
}

/** GET /items: a playlist, channel, feed or page expanded to video refs. */
export async function getItems(input: string, call: CallOptions = {}, limit = 200): Promise<VideoRef[]> {
  const res = await getJson<{ items: VideoRef[] }>('/items', { url: input, limit: String(limit) }, call);
  return res.items;
}

/** A playlist a video link sits in, with what the banner needs to show it. */
export interface PlaylistInfo {
  /** The playlist's own link: opening it lists every video. */
  url: string;
  title?: string;
  /** Videos in the playlist, when the platform reports a count. */
  count?: number;
}

/**
 * The playlist a video link also names (a YouTube watch URL with list=), or
 * null when it names none. GET /items says whether there is one; GET /metadata
 * on the playlist adds its title and size. A playlist whose metadata cannot be
 * read is still returned, without title and count.
 */
export async function getPlaylistOf(input: string, call: CallOptions = {}): Promise<PlaylistInfo | null> {
  const res = await getJson<{ items: VideoRef[]; list?: VideoRef }>('/items', { url: input, limit: '1' }, call);
  const list = res.list;
  if (!list) return null;
  const url = list.url ?? list.input;
  try {
    const meta = await getJson<VideoMetadata>('/metadata', { url }, call);
    const count = meta.extra?.itemCount;
    return {
      url,
      ...(meta.title ? { title: meta.title } : {}),
      ...(typeof count === 'number' ? { count } : {}),
    };
  } catch (err) {
    if (call.signal?.aborted) throw err;
    return { url };
  }
}

/** GET /comments. */
export async function getComments(input: string, call: CallOptions = {}, limit = 100): Promise<VideoContext['comments']> {
  const res = await getJson<{ comments: NonNullable<VideoContext['comments']> }>(
    '/comments',
    { url: input, limit: String(limit) },
    call,
  );
  return res.comments;
}

export interface Health {
  ok: boolean;
  name: string;
  version: string;
  runtime: string;
  formats: { id: string; description: string; mimeType: string }[];
  /** Provider keys this server accepts per request (names only). Absent on servers older than this field. */
  requestKeys?: { accepted: boolean; names: string[] };
}

/** GET /health. Throws unless the answer really comes from a vid2context server. */
export async function getHealth(call: CallOptions = {}): Promise<Health> {
  const base = call.base ?? apiBase();
  const h = await getJson<Partial<Health>>('/health', {}, { ...call, base });
  if (h.name !== 'vid2context' || !Array.isArray(h.formats)) throw notAnApi(base, 200);
  return h as Health;
}

/** The server says the input is a playlist, channel, feed or page: expand it with /items instead. */
export function isListError(err: unknown): boolean {
  return (
    err instanceof Vid2ContextError &&
    err.code === 'unsupported-input' &&
    / is a (playlist|channel|feed|page), not a single video/.test(err.message)
  );
}

export interface UploadResult {
  input: string;
  filename: string;
  bytes: number;
  mimeType: string;
  expiresAt: string;
}

/**
 * POST /uploads as multipart with field `file`. Uses XMLHttpRequest because
 * fetch cannot report upload progress.
 */
export function uploadFile(
  file: Blob,
  filename: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const base = apiBase();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/uploads`);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onerror = () => reject(unreachable(base));
    xhr.onabort = () => reject(new DOMException('Upload canceled', 'AbortError'));
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(notAnApi(base, xhr.status));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadResult);
      else if (isApiErrorBody(body)) reject(fromApiBody(body, xhr.status));
      else reject(notAnApi(base, xhr.status));
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append('file', file, filename);
    xhr.send(form);
  });
}
