/**
 * Standard Webhooks signing and verification (https://www.standardwebhooks.com/).
 *
 * The signed content is `${webhookId}.${timestampSeconds}.${body}`, signed with
 * HMAC-SHA256 under the secret's decoded bytes, sent as `v1,<base64>` in the
 * `webhook-signature` header (space-separated when several keys sign during a
 * rotation). Secrets are `whsec_` plus base64. Everything here uses WebCrypto,
 * so it runs on Node, Workers and in the browser.
 */
import { Vid2ContextError } from '@vid2context/core';

export const SECRET_PREFIX = 'whsec_';
/** Receivers reject timestamps further than this from their clock (the spec's 5 minutes). */
export const DEFAULT_TOLERANCE_SEC = 5 * 60;

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decodes standard base64, padded or not. Throws on characters outside the alphabet. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new Error('invalid base64');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomToken(bytes: number): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A new signing secret: `whsec_` plus 24 random bytes in base64. Show it to the user once. */
export function generateSecret(): string {
  return SECRET_PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(24)));
}

/** A message id for the `webhook-id` header. URL-safe base64, so it never contains a `.`. */
export function generateMessageId(): string {
  return `msg_${randomToken(18)}`;
}

/** The secret's key bytes. Accepts the `whsec_` form or bare base64, as the reference libraries do. */
export function secretBytes(secret: string): Uint8Array {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(raw);
  } catch {
    throw new Vid2ContextError('bad-request', 'The webhook secret is not valid base64.', {
      hint: 'Use the secret exactly as vid2context returned it when the webhook was created (it starts with whsec_).',
    });
  }
  if (bytes.length === 0) {
    throw new Vid2ContextError('bad-request', 'The webhook secret is empty.', {
      hint: 'Use the secret exactly as vid2context returned it when the webhook was created (it starts with whsec_).',
    });
  }
  return bytes;
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const raw = secretBytes(secret);
  return crypto.subtle.importKey('raw', raw.slice().buffer, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

function bodyBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? encoder.encode(body) : body;
}

function signedContent(id: string, timestampSec: number, body: string | Uint8Array): ArrayBuffer {
  const prefix = encoder.encode(`${id}.${timestampSec}.`);
  const payload = bodyBytes(body);
  const out = new Uint8Array(prefix.length + payload.length);
  out.set(prefix);
  out.set(payload, prefix.length);
  return out.buffer;
}

/** The `v1,<base64>` signature for one message. `timestampSec` is whole seconds since the epoch. */
export async function sign(secret: string, id: string, timestampSec: number, body: string | Uint8Array): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const mac = await crypto.subtle.sign('HMAC', key, signedContent(id, Math.floor(timestampSec), body));
  return `v1,${toBase64(new Uint8Array(mac))}`;
}

export interface SignedHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/** The three Standard Webhooks headers for one delivery attempt. */
export async function signedHeaders(
  secret: string,
  id: string,
  timestampSec: number,
  body: string | Uint8Array,
): Promise<SignedHeaders> {
  const ts = Math.floor(timestampSec);
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': await sign(secret, id, ts, body) };
}

export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(' ') : v;
  }
  return undefined;
}

function verifyError(message: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, {
    hint: 'Pass the raw request body exactly as received (not re-serialized JSON), the webhook-* headers, and the secret shown when the webhook was created; check that this machine clock is correct.',
  });
}

export interface VerifyOptions {
  /** Seconds either side of now a timestamp may be. Default 300. */
  toleranceSec?: number;
  /** Override the clock, in seconds since the epoch (for replaying a stored request). */
  nowSec?: number;
}

/**
 * Verify a received webhook. `body` must be the raw body, byte for byte as
 * received. Returns the parsed JSON payload on success (or `undefined` for an
 * empty body) and throws a `bad-request` Vid2ContextError otherwise.
 */
export async function verifyWebhook<T = unknown>(
  secret: string,
  headers: HeaderSource,
  body: string | Uint8Array,
  opts: VerifyOptions = {},
): Promise<T> {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signature = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signature) throw verifyError('Missing webhook-id, webhook-timestamp or webhook-signature header.');
  if (!/^\d+$/.test(timestamp)) throw verifyError('The webhook-timestamp header is not a whole number of seconds.');
  const ts = Number(timestamp);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (now - ts > tolerance) throw verifyError('The webhook timestamp is too old.');
  if (ts - now > tolerance) throw verifyError('The webhook timestamp is too far in the future.');

  const key = await hmacKey(secret, 'verify');
  const content = signedContent(id, ts, body);
  let matched = false;
  for (const candidate of signature.split(' ')) {
    const comma = candidate.indexOf(',');
    if (comma < 0 || candidate.slice(0, comma) !== 'v1') continue;
    let mac: Uint8Array;
    try {
      mac = fromBase64(candidate.slice(comma + 1));
    } catch {
      continue;
    }
    // crypto.subtle.verify compares in constant time.
    if (await crypto.subtle.verify('HMAC', key, mac.slice().buffer, content)) {
      matched = true;
      break;
    }
  }
  if (!matched) throw verifyError('No webhook signature matched.');
  const bytes = bodyBytes(body);
  if (bytes.length === 0) return undefined as T;
  return JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(bytes)) as T;
}
