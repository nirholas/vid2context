/**
 * Small Web Crypto helpers that run unchanged on Node 22+, Workers and the
 * browser: random tokens, SHA-256, base64url, constant-time comparison and
 * the PKCE S256 check.
 */

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A URL-safe random token with `bytes` bytes of entropy (default 32, so 256 bits). */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
}

export async function sha256Hex(input: string): Promise<string> {
  const h = await sha256(input);
  let out = '';
  for (const b of h) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Compare two byte arrays without an early exit, so timing does not reveal how many leading bytes match. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/** RFC 7636 code verifier syntax: 43 to 128 characters of [A-Z a-z 0-9 - . _ ~]. */
export function isValidCodeVerifier(v: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}

/** RFC 7636 S256: BASE64URL(SHA256(ascii(code_verifier))) must equal the stored challenge. */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  if (!isValidCodeVerifier(verifier)) return false;
  const computed = base64url(await sha256(verifier));
  return timingSafeEqualString(computed, challenge);
}
