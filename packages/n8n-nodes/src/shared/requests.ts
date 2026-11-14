/**
 * Request builders for the vid2context HTTP API (docs/contracts/http-api.md).
 * Pure functions that return n8n request options, so they are unit-tested
 * against a real server without n8n. The node passes them to
 * `this.helpers.httpRequestWithAuthentication`, which adds the API key from
 * the credential.
 */
import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';

export const EVENTS = ['video.ingested', 'collection.updated', 'job.succeeded', 'job.failed', 'brief.ready'] as const;
export const MODES = ['auto', 'captions', 'stt', 'video'] as const;

/** The server root from whatever the user typed: trailing slashes and a trailing /api/v1 are dropped. */
export function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed))
    throw new Error(`The vid2context base URL must start with http:// or https:// (got "${baseUrl}").`);
  return trimmed.replace(/\/api\/v1$/i, '');
}

function query(values: Record<string, string | boolean | undefined>): IDataObject {
  const out: IDataObject = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === '' || v === false) continue;
    out[k] = v === true ? '1' : v;
  }
  return out;
}

export interface VideoParams {
  url: string;
  mode?: string;
  lang?: string;
}

export interface TranscriptParams extends VideoParams {
  format?: string;
  timestamps?: boolean;
}

function requireUrl(url: string): string {
  const v = url.trim();
  if (!v) throw new Error('Video URL is empty: pass a video URL or id, for example https://youtu.be/jNQXAC9IVRw.');
  return v;
}

/** GET /api/v1/transcript. The body is text in the chosen format, so it is read as text. */
export function transcriptRequest(base: string, p: TranscriptParams): IHttpRequestOptions {
  return {
    method: 'GET',
    baseURL: base,
    url: '/api/v1/transcript',
    qs: query({ url: requireUrl(p.url), format: p.format || 'text', timestamps: p.timestamps, mode: p.mode, lang: p.lang }),
    encoding: 'text',
    json: false,
    returnFullResponse: true,
  };
}

/** GET /api/v1/context: the full VideoContext (metadata, timed transcript, attempts). */
export function contextRequest(base: string, p: VideoParams): IHttpRequestOptions {
  return {
    method: 'GET',
    baseURL: base,
    url: '/api/v1/context',
    qs: query({ url: requireUrl(p.url), mode: p.mode, lang: p.lang }),
    json: true,
  };
}

/** GET /api/v1/health: formats and providers (no secrets). */
export function healthRequest(base: string): IHttpRequestOptions {
  return { method: 'GET', baseURL: base, url: '/api/v1/health', json: true };
}

export function listWebhooksRequest(base: string): IHttpRequestOptions {
  return { method: 'GET', baseURL: base, url: '/api/v1/webhooks', json: true };
}

export function createWebhookRequest(
  base: string,
  body: { url: string; events: string[]; description?: string },
): IHttpRequestOptions {
  return { method: 'POST', baseURL: base, url: '/api/v1/webhooks', body, json: true };
}

/** DELETE /api/v1/webhooks/:id. Status errors are returned, not thrown, so a 404 (already gone) can be accepted. */
export function deleteWebhookRequest(base: string, id: string): IHttpRequestOptions {
  return {
    method: 'DELETE',
    baseURL: base,
    url: `/api/v1/webhooks/${encodeURIComponent(id)}`,
    json: true,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
  };
}

export interface FullResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** Turns a transcript response into an output item: JSON formats are parsed, everything else is kept as text. */
export function transcriptItem(p: TranscriptParams, res: FullResponse): IDataObject {
  const raw = res.headers['content-type'];
  const contentType = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  const item: IDataObject = { url: p.url, format: p.format || 'text', contentType };
  if (/\bjson\b/i.test(contentType)) item.transcript = JSON.parse(text) as IDataObject;
  else item.transcript = text;
  return item;
}
