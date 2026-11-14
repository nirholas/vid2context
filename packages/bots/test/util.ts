/**
 * Test utilities with no provider imports: fixture reading, signing requests
 * the way the platforms do, and reading multipart bodies.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slackSignature } from '../src/verify.ts';

export const ROOT = join(import.meta.dirname, '../../..');
export const FIXTURES = join(import.meta.dirname, 'fixtures');

export const readRepo = (p: string) => readFileSync(join(ROOT, p), 'utf8');
export const readFixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(readFixture(name)) as T;

/** Sign a Slack request body the way Slack does (v0 HMAC-SHA256), for a real body and the current time. */
export async function slackHeaders(secret: string, body: string, timestamp: number): Promise<Record<string, string>> {
  return {
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': await slackSignature(secret, String(timestamp), body),
  };
}

/** A fresh Ed25519 key pair; the public key as the hex string Discord shows in the Developer Portal. */
export async function discordKeys(): Promise<{
  publicKeyHex: string;
  sign: (timestamp: string, body: string) => Promise<string>;
}> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return {
    publicKeyHex: hex(raw),
    sign: async (timestamp, body) =>
      hex(new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(timestamp + body)))),
  };
}

/** Text of a multipart field (string or file). */
export async function formField(body: unknown, name: string): Promise<string> {
  if (!(body instanceof FormData)) throw new Error('expected a multipart body');
  const v = body.get(name);
  if (v === null) throw new Error(`no field ${name}`);
  return typeof v === 'string' ? v : await v.text();
}
