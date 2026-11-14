/**
 * Send a request built by playground.ts and read the answer the way the API
 * page shows it: text streams in as it arrives (server-sent events, long
 * transcripts), JSON is parsed once complete, and a .zip is kept as a blob.
 */
import { isApiErrorBody } from './errors.ts';
import type { BuiltRequest } from './playground.ts';

export interface Answer {
  status: number;
  statusText: string;
  ok: boolean;
  /** Time to the response headers, and to the last byte, in milliseconds. */
  firstByteMs: number;
  ms: number;
  bytes: number;
  contentType: string;
  headers: [string, string][];
  text: string;
  json?: unknown;
  blob?: Blob;
  filename?: string;
}

export type Outcome =
  | { state: 'sending'; startedAt: number; partial?: Partial<Answer> }
  | { state: 'done'; answer: Answer }
  | { state: 'failed'; message: string; ms: number }
  | { state: 'canceled'; ms: number; partial?: Partial<Answer> };

export interface SendOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Called with the answer so far while text streams in, at most every `throttleMs`. */
  onProgress?: (partial: Partial<Answer>) => void;
  throttleMs?: number;
  now?: () => number;
}

function isBinary(contentType: string): boolean {
  return /zip|octet-stream|audio\/|video\/|image\//.test(contentType);
}

function filenameOf(disposition: string | null): string | undefined {
  return disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
}

/** True when the error body has the standard { error: { code, message, hint } } shape. */
export function errorOf(answer: Answer): { code: string; message: string; hint?: string } | undefined {
  return isApiErrorBody(answer.json) ? answer.json.error : undefined;
}

export async function send(req: BuiltRequest, opts: SendOptions = {}): Promise<Answer> {
  const now = opts.now ?? (() => performance.now());
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const started = now();
  let body: BodyInit | undefined;
  if (typeof req.body === 'string') body = req.body;
  else if (req.body?.file) {
    const form = new FormData();
    form.append(req.body.field, req.body.file, req.body.file.name);
    body = form;
  }
  const res = await doFetch(req.url, { method: req.method, headers: req.headers, body, signal: opts.signal });
  const firstByteMs = now() - started;
  const contentType = res.headers.get('content-type') ?? '';
  const headers = [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
  const base = { status: res.status, statusText: res.statusText, ok: res.ok, firstByteMs, contentType, headers };

  if (isBinary(contentType) && res.ok) {
    const blob = await res.blob();
    return {
      ...base,
      ms: now() - started,
      bytes: blob.size,
      text: '',
      blob,
      filename: filenameOf(res.headers.get('content-disposition')),
    };
  }

  let text = '';
  let bytes = 0;
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const throttle = opts.throttleMs ?? 80;
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      const t = now();
      if (opts.onProgress && t - last >= throttle) {
        last = t;
        opts.onProgress({ ...base, text, bytes });
      }
    }
    text += decoder.decode();
  }
  let json: unknown;
  if (contentType.includes('json')) {
    try {
      json = JSON.parse(text);
    } catch {
      // Not valid JSON despite the header: shown as text.
    }
  }
  return { ...base, ms: now() - started, bytes, text, json };
}

/** The body as the page shows it: JSON pretty-printed, anything else as served. */
export function displayText(answer: Pick<Answer, 'json' | 'text'>): string {
  return answer.json !== undefined ? JSON.stringify(answer.json, null, 2) : answer.text;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
