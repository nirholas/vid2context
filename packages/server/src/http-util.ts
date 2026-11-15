/** Query, body and caching helpers shared by the route modules. */
import { type Formatter, formatters, type TranscriptMode } from '@vid2context/core';
import type { Context } from 'hono';
import { badRequest } from './errors.ts';

const MODES: TranscriptMode[] = ['auto', 'captions', 'stt', 'video'];

export function readMode(v: string | undefined): TranscriptMode {
  const mode = (v || 'auto') as TranscriptMode;
  if (!MODES.includes(mode)) throw badRequest(`Unknown mode "${v}".`, `Use one of: ${MODES.join(', ')}.`);
  return mode;
}

export function readUrl(v: string | undefined): string {
  if (!v?.trim()) throw badRequest('Missing the url query parameter.', 'Pass ?url=<video URL>.');
  return v;
}

export function readFlag(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
}

/** An optional positive integer within [min, max]. */
export function readInt(name: string, v: string | undefined, opts: { min?: number; max: number }): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  const min = opts.min ?? 1;
  if (!Number.isInteger(n) || n < min || n > opts.max) {
    throw badRequest(
      `${name} must be a whole number from ${min} to ${opts.max}.`,
      `Pass ?${name}=<${min}..${opts.max}> or leave it out.`,
    );
  }
  return n;
}

export function readFormat(v: string | undefined, fallback = 'text'): Formatter {
  const id = v || fallback;
  const f = formatters[id];
  if (!f) throw badRequest(`Unknown format "${id}".`, `Available formats: ${Object.keys(formatters).join(', ')}.`);
  return f;
}

/** Comma-separated list, trimmed, empties dropped. */
export function readList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/** Parse a JSON object body. An empty body counts as `{}` when `allowEmpty`. */
export async function readJsonObject(c: Context, opts: { allowEmpty?: boolean } = {}): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim() && opts.allowEmpty) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest('The request body is not valid JSON.', 'Send a JSON object with Content-Type: application/json.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest(
      'The request body must be a JSON object.',
      'Send a JSON object, for example {"inputs": ["https://youtu.be/jNQXAC9IVRw"]}.',
    );
  }
  return body as Record<string, unknown>;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v.trim())
    throw badRequest(`"${key}" must be a non-empty string.`, `Pass "${key}" as a string or leave it out.`);
  return v;
}

export function optionalStrings(body: Record<string, unknown>, key: string): string[] | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) {
    throw badRequest(`"${key}" must be an array of strings.`, `Pass "${key}" as ["...", "..."] or leave it out.`);
  }
  return v as string[];
}

export function optionalPositiveInt(body: Record<string, unknown>, key: string, max: number): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
    throw badRequest(`"${key}" must be a whole number from 1 to ${max}.`, `Pass "${key}" as a JSON number or leave it out.`);
  }
  return v;
}

export function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean')
    throw badRequest(`"${key}" must be true or false.`, `Pass "${key}" as a JSON boolean or leave it out.`);
  return v;
}

const encoder = new TextEncoder();

/** A strong ETag: base64url of the body's SHA-256, first 27 characters. */
export async function etagOf(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  const b64 = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `"${b64.slice(0, 27)}"`;
}

/** True when an If-None-Match header matches the ETag (weak comparison, as RFC 9110 requires for If-None-Match). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => t.trim() === '*' || strip(t) === strip(etag));
}

/** JSON with an ETag; answers 304 Not Modified when the client already has this version. */
export async function jsonWithEtag(c: Context, value: unknown): Promise<Response> {
  const text = JSON.stringify(value);
  const etag = await etagOf(text);
  const headers = { etag, 'cache-control': 'private, no-cache' };
  if (etagMatches(c.req.header('if-none-match'), etag)) return c.body(null, 304, headers);
  return c.body(text, 200, { ...headers, 'content-type': 'application/json' });
}

/** `false` when an opt-out flag is set to 0, false, no or off; undefined (the default applies) otherwise. */
export function readOptOut(v: string | undefined): false | undefined {
  return ['0', 'false', 'no', 'off'].includes((v ?? '').trim().toLowerCase()) ? false : undefined;
}

// Titles come from the internet: path separators, characters Windows forbids, and control characters go.
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters.
const UNSAFE_NAME = /[\u0000-\u001f\u007f"\\/:*?<>|]+/g;

/**
 * `Content-Disposition: attachment` for a download named `name`. The quoted
 * `filename` is a plain ASCII fallback; when the name has other characters,
 * `filename*` (RFC 5987) carries it in UTF-8 for browsers that read it.
 */
export function attachment(name: string): string {
  const safe =
    name
      .replace(UNSAFE_NAME, ' ')
      .replace(/\s+/g, ' ')
      .replace(/ (?=\.)/g, '')
      .replace(/^[\s.]+|[\s.]+$/g, '') || 'download';
  const ascii = safe
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]+|[%;]/g, '_')
    .replace(/_+/g, '_');
  if (ascii === safe) return `attachment; filename="${ascii}"`;
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
