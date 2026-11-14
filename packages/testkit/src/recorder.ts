/**
 * Record real HTTP exchanges into fixture files, and replay them.
 *
 * recordingFetch wraps a real fetch: every request runs for real, then the
 * exchange is scrubbed (keys, tokens, cookies, IP-bearing stream params) and
 * written as `<name>-001.json`, `<name>-002.json`, ... in call order.
 * fixtureRoutes turns those files back into Route[] for replayFetch, so a
 * unit test can replay a real run without touching the network.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordedResponse, Route } from '@vid2context/core/testing';
import { mergeReports, REDACTED, REDACTED_URL, Scrubber, type ScrubOptions, type ScrubReport, SECRET_HEADERS } from './scrub.ts';

/** Request headers worth keeping in a fixture. Secret headers are kept too, with their value replaced. */
export const REQUEST_HEADER_ALLOWLIST = [
  'accept',
  'accept-language',
  'content-type',
  'origin',
  'range',
  'referer',
  'user-agent',
  'x-youtube-client-name',
  'x-youtube-client-version',
];

/** Response headers worth keeping: the ones providers read (type, rate limits, redirects). */
export const RESPONSE_HEADER_ALLOWLIST = ['content-type', 'retry-after', 'location', 'x-ratelimit-*', 'ratelimit*'];

/** Largest request body stored, in bytes. Larger text bodies are cut; larger binary bodies are left out (size is kept). */
export const REQUEST_BODY_CAP = 32 * 1024;

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export interface RecordedExchange {
  /** ISO 8601. */
  recordedAt: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    bodyEncoding?: 'text' | 'base64';
    bodyBytes?: number;
    bodyTruncated?: boolean;
  };
  response: {
    status: number;
    statusText?: string;
    headers: Record<string, string>;
    body: string;
    bodyEncoding: 'text' | 'base64';
  };
}

export interface RecordingOptions {
  /** Directory to write into (created when missing). */
  dir: string;
  /** File name prefix: `<name>-001.json`. Default 'rec'. */
  name?: string;
  /** Extra scrubbing input. Scrubbing itself is always on. */
  scrub?: ScrubOptions;
}

export type RecordingFetch = typeof fetch & {
  /** Paths written so far, in call order. */
  readonly files: string[];
  /** What was scrubbed, summed over every exchange. */
  report(): ScrubReport;
  /** Per-file scrub reports. */
  reports(): { file: string; report: ScrubReport }[];
};

function allowed(name: string, list: string[]): boolean {
  return list.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

function pickHeaders(h: Headers, list: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (allowed(lower, list) || SECRET_HEADERS.includes(lower)) out[lower] = v;
  });
  return out;
}

const BINARY_TYPE = /^(audio|video|image|font)\/|application\/(octet-stream|zip|gzip|pdf|x-protobuf|vnd\.google\.protobuf)/i;

function decodeBody(bytes: Uint8Array, contentType: string | null): { text: string } | { base64: string } {
  if (contentType && BINARY_TYPE.test(contentType)) return { base64: toBase64(bytes) };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { base64: toBase64(bytes) };
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

async function requestBytes(body: RequestInit['body'] | undefined): Promise<Uint8Array | 'stream' | undefined> {
  if (body === undefined || body === null) return undefined;
  if (body instanceof ReadableStream) return 'stream';
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** Wrap a real fetch so every exchange is scrubbed and written to `dir` in call order. */
export function recordingFetch(realFetch: typeof fetch, opts: RecordingOptions): RecordingFetch {
  const name = opts.name ?? 'rec';
  const files: string[] = [];
  const perFile: { file: string; report: ScrubReport }[] = [];
  let counter = 0;
  mkdirSync(opts.dir, { recursive: true });

  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const index = ++counter;
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const reqHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => {
      reqHeaders.set(k, v);
    });
    const rawBody = await requestBytes(init?.body);

    const res = await realFetch(input, init);
    const resBytes = new Uint8Array(await res.arrayBuffer());

    const s = new Scrubber(opts.scrub);
    const request: RecordedExchange['request'] = {
      method,
      url: s.url(new URL(href).href, 'request.url'),
      headers: s.headers(pickHeaders(reqHeaders, REQUEST_HEADER_ALLOWLIST), 'request.headers'),
    };
    if (rawBody === 'stream') {
      request.bodyTruncated = true;
    } else if (rawBody) {
      request.bodyBytes = rawBody.byteLength;
      const decoded = decodeBody(rawBody, reqHeaders.get('content-type'));
      if ('text' in decoded) {
        const cut = decoded.text.length > REQUEST_BODY_CAP;
        request.body = s.body(cut ? decoded.text.slice(0, REQUEST_BODY_CAP) : decoded.text, 'request.body');
        request.bodyEncoding = 'text';
        if (cut) request.bodyTruncated = true;
      } else if (rawBody.byteLength <= REQUEST_BODY_CAP) {
        request.body = decoded.base64;
        request.bodyEncoding = 'base64';
      } else {
        request.bodyTruncated = true;
      }
    }

    const decoded = decodeBody(resBytes, res.headers.get('content-type'));
    const response: RecordedExchange['response'] = {
      status: res.status,
      ...(res.statusText ? { statusText: res.statusText } : {}),
      headers: s.headers(pickHeaders(res.headers, RESPONSE_HEADER_ALLOWLIST), 'response.headers'),
      body: 'text' in decoded ? s.body(decoded.text, 'response.body') : decoded.base64,
      bodyEncoding: 'text' in decoded ? 'text' : 'base64',
    };

    const file = join(opts.dir, `${name}-${String(index).padStart(3, '0')}.json`);
    const exchange: RecordedExchange = { recordedAt: new Date().toISOString(), request, response };
    writeFileSync(file, `${JSON.stringify(exchange, null, 2)}\n`);
    files.push(file);
    perFile.push({ file, report: s.report() });

    // Hand the caller the real response. The body was already decoded by fetch, so drop the encoding headers.
    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(NULL_BODY_STATUS.has(res.status) ? null : resBytes, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };

  return Object.assign(fn, {
    files,
    report: () => mergeReports(perFile.map((p) => p.report)),
    reports: () => perFile.map((p) => ({ file: p.file, report: p.report })),
  }) as RecordingFetch;
}

const FILE_RE = /^(.+)-(\d{3,})\.json$/;

/** Read recorded exchanges from `dir` in recorded order. With `name`, only `<name>-NNN.json` files. */
export function readRecorded(dir: string, opts: { name?: string } = {}): { file: string; exchange: RecordedExchange }[] {
  const entries = readdirSync(dir)
    .map((f) => ({ f, m: FILE_RE.exec(f) }))
    .filter((e): e is { f: string; m: RegExpExecArray } => e.m !== null && (opts.name === undefined || e.m[1] === opts.name))
    .sort((a, b) => (a.m[1] ?? '').localeCompare(b.m[1] ?? '') || Number(a.m[2]) - Number(b.m[2]));
  const out: { file: string; exchange: RecordedExchange }[] = [];
  for (const { f } of entries) {
    const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<RecordedExchange>;
    if (!parsed.request?.url || !parsed.response) continue;
    out.push({ file: join(dir, f), exchange: parsed as RecordedExchange });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turn a scrubbed recorded URL into a matcher: exact when nothing was redacted, else REDACTED matches any value. */
function urlMatcher(recorded: string): string | ((url: URL) => boolean) {
  if (!recorded.includes(REDACTED_URL)) return recorded;
  const re = new RegExp(`^${escapeRe(recorded).split(REDACTED_URL).join('[^&/?#]*')}$`);
  return (url: URL) => re.test(url.href);
}

function toResponse(r: RecordedExchange['response']): RecordedResponse {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) if (v !== REDACTED) headers[k] = v;
  return {
    status: r.status,
    headers,
    body: r.bodyEncoding === 'base64' ? new Uint8Array(Buffer.from(r.body, 'base64')) : r.body,
  };
}

/**
 * Load recorded files as routes for replayFetch. Matching is exact URL plus
 * method. A URL recorded several times answers with its responses in recorded
 * order, then keeps answering with the last one.
 */
export function fixtureRoutes(dir: string, opts: { name?: string } = {}): Route[] {
  const groups = new Map<string, RecordedExchange[]>();
  for (const { exchange } of readRecorded(dir, opts)) {
    const key = `${exchange.request.method} ${exchange.request.url}`;
    const list = groups.get(key) ?? [];
    list.push(exchange);
    groups.set(key, list);
  }
  const routes: Route[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    if (!first) continue;
    let i = 0;
    routes.push({
      method: first.request.method,
      url: urlMatcher(first.request.url),
      response: () => {
        const ex = list[Math.min(i, list.length - 1)] ?? first;
        i++;
        return toResponse(ex.response);
      },
    });
  }
  return routes;
}
