/**
 * Standard Webhooks verification for the trigger node. n8n loads community
 * nodes as compiled JavaScript with no runtime dependencies, so this is a
 * small self-contained copy of the check in @vid2context/webhooks (same
 * scheme, tested against the same published vectors and the official
 * standardwebhooks library): HMAC-SHA256 over `${id}.${timestamp}.${body}`,
 * `v1,<base64>` signatures, a 5 minute timestamp tolerance.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOLERANCE_SEC = 5 * 60;

export type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(' ') : v;
  }
  return undefined;
}

function keyBytes(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  if (!/^[A-Za-z0-9+/]+=*$/.test(raw)) throw new Error('The stored webhook secret is not valid base64.');
  return Buffer.from(raw, 'base64');
}

export function signPayload(secret: string, id: string, timestampSec: number, body: Buffer | string): string {
  const mac = createHmac('sha256', keyBytes(secret))
    .update(`${id}.${Math.floor(timestampSec)}.`)
    .update(body)
    .digest('base64');
  return `v1,${mac}`;
}

/**
 * Throws an Error saying what failed, or returns the parsed payload. `body`
 * must be the raw request body as received.
 */
export function verifySignature(secret: string, headers: HeaderBag, body: Buffer | string, nowSec = Date.now() / 1000): unknown {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signature = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signature) throw new Error('Missing webhook-id, webhook-timestamp or webhook-signature header.');
  if (!/^\d+$/.test(timestamp)) throw new Error('The webhook-timestamp header is not a whole number of seconds.');
  const ts = Number(timestamp);
  if (Math.abs(Math.floor(nowSec) - ts) > TOLERANCE_SEC)
    throw new Error('The webhook timestamp is outside the 5 minute tolerance.');
  const expected = Buffer.from(signPayload(secret, id, ts, body).slice(3), 'base64');
  const matched = signature.split(' ').some((candidate) => {
    if (!candidate.startsWith('v1,')) return false;
    const got = Buffer.from(candidate.slice(3), 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!matched) throw new Error('No webhook signature matched.');
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  return text.length === 0 ? {} : JSON.parse(text);
}
