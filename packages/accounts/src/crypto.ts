/**
 * Small WebCrypto helpers. Runtime-neutral: Node 22, Workers and browsers all
 * expose `crypto.getRandomValues` and `crypto.subtle`, so nothing here imports
 * `node:crypto`.
 */

const encoder = new TextEncoder();

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `n` random bytes as base64url (32 bytes give 43 characters). */
export function randomToken(n = 32): string {
  return base64url(randomBytes(n));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await sha256(text));
}

export async function sha256Base64url(text: string): Promise<string> {
  return base64url(await sha256(text));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    // Keep the cache tiny: one entry per configured secret.
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(secret, key);
  }
  return key;
}

/** HMAC-SHA256 of `message`, base64url. */
export async function hmac(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message));
  return base64url(new Uint8Array(sig));
}

/** Constant-time string comparison (length is not secret). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `value.signature`, where signature is HMAC-SHA256(secret, value). */
export async function sign(secret: string, value: string): Promise<string> {
  return `${value}.${await hmac(secret, value)}`;
}

/** The value inside a signed string, or null when the signature does not match. */
export async function unsign(secret: string, signed: string): Promise<string | null> {
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const expected = await hmac(secret, value);
  return timingSafeEqual(expected, signed.slice(dot + 1)) ? value : null;
}
