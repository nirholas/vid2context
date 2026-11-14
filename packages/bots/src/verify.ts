/**
 * Request verification for the three platforms. WebCrypto only (no node:*),
 * so the same code runs on Node 22+ and Cloudflare Workers.
 *
 *   Telegram  X-Telegram-Bot-Api-Secret-Token equals the secret given to setWebhook
 *   Discord   Ed25519 signature over timestamp + raw body, with the app's public key
 *   Slack     v0 HMAC-SHA256 over "v0:<timestamp>:<raw body>" with the signing secret,
 *             timestamps more than 5 minutes from now are rejected (replay protection)
 *
 * Every check runs on the raw body before anything is parsed.
 */

const enc = new TextEncoder();

/** Compare two strings without an early exit, so timing does not reveal how much matched. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function verifyTelegram(secret: string, header: string | null | undefined): boolean {
  if (!header) return false;
  return timingSafeEqual(header, secret);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const discordKeys = new Map<string, Promise<CryptoKey>>();

function discordKey(publicKeyHex: string): Promise<CryptoKey> {
  let key = discordKeys.get(publicKeyHex);
  if (!key) {
    const raw = hexToBytes(publicKeyHex);
    if (!raw || raw.length !== 32) return Promise.reject(new Error('DISCORD_PUBLIC_KEY must be 64 hex characters'));
    key = crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify']);
    // A key that fails to import is not cached, so a fixed env var is picked up on the next request.
    key.catch(() => discordKeys.delete(publicKeyHex));
    discordKeys.set(publicKeyHex, key);
  }
  return key;
}

export async function verifyDiscord(
  publicKeyHex: string,
  signatureHex: string | null | undefined,
  timestamp: string | null | undefined,
  body: string,
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
  const sig = hexToBytes(signatureHex);
  if (!sig || sig.length !== 64) return false;
  try {
    const key = await discordKey(publicKeyHex);
    return await crypto.subtle.verify('Ed25519', key, sig as Uint8Array<ArrayBuffer>, enc.encode(timestamp + body));
  } catch {
    return false;
  }
}

/** Largest allowed distance between Slack's timestamp and our clock. */
export const SLACK_MAX_AGE_SEC = 5 * 60;

export async function slackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`v0:${timestamp}:${body}`));
  return `v0=${bytesToHex(mac)}`;
}

export async function verifySlack(
  secret: string,
  signature: string | null | undefined,
  timestamp: string | null | undefined,
  body: string,
  nowSec: number,
): Promise<boolean> {
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > SLACK_MAX_AGE_SEC) return false;
  return timingSafeEqual(await slackSignature(secret, timestamp, body), signature);
}
