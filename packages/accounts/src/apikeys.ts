/**
 * Personal API keys: `v2c_` plus 32 random bytes in base64url. The full key
 * is returned once, on creation; the store keeps only its SHA-256 hash, a
 * name, a short display prefix and the created and last-used times.
 *
 * Keys:
 *   accounts:key:<sha256(key)>          ApiKeyRecord
 *   accounts:keys:<accountId>:<keyId>   sha256(key), for listing an account's keys
 */
import { type KvStore, Vid2ContextError } from '@vid2context/core';
import { randomToken, sha256Hex } from './crypto.ts';

export const API_KEY_PREFIX = 'v2c_';
/** Most keys one account may hold. */
export const MAX_KEYS_PER_ACCOUNT = 20;
/** last-used times are written at most this often per key, to keep KV writes low. */
const TOUCH_EVERY_MS = 60 * 60 * 1000;

export interface ApiKeyRecord {
  id: string;
  accountId: string;
  name: string;
  /** First characters of the key, enough to recognise it in a list. */
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** What GET /me/keys returns per key. */
export type ApiKeyInfo = Omit<ApiKeyRecord, 'accountId'>;

const recordKey = (hash: string) => `accounts:key:${hash}`;
const indexPrefix = (accountId: string) => `accounts:keys:${accountId}:`;

/** True when a string has the shape of a vid2context API key (cheap check before hashing). */
export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && /^v2c_[A-Za-z0-9_-]{43}$/.test(value);
}

export function hashApiKey(key: string): Promise<string> {
  return sha256Hex(key);
}

function cleanName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '';
  if (!s || s.length > 64) {
    throw new Vid2ContextError('bad-request', 'An API key needs a name of 1 to 64 characters.', {
      hint: 'Send {"name": "my laptop"} in the request body.',
    });
  }
  return s;
}

async function indexEntries(kv: KvStore, accountId: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.kvList(indexPrefix(accountId), { limit: 100, cursor });
    out.push(...page.keys);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/** Create a key. Returns the full key (show it once) and the stored record. */
export async function createApiKey(
  kv: KvStore,
  accountId: string,
  name: unknown,
  now = new Date(),
): Promise<{ key: string; record: ApiKeyRecord }> {
  const clean = cleanName(name);
  if ((await indexEntries(kv, accountId)).length >= MAX_KEYS_PER_ACCOUNT) {
    throw new Vid2ContextError('bad-request', `This account already has ${MAX_KEYS_PER_ACCOUNT} API keys.`, {
      hint: 'Delete a key you no longer use (DELETE /api/v1/me/keys/:id), then create a new one.',
    });
  }
  const key = `${API_KEY_PREFIX}${randomToken(32)}`;
  const hash = await hashApiKey(key);
  const record: ApiKeyRecord = {
    id: `key_${randomToken(9)}`,
    accountId,
    name: clean,
    prefix: key.slice(0, 8),
    createdAt: now.toISOString(),
  };
  await kv.kvSet(recordKey(hash), record);
  await kv.kvSet(`${indexPrefix(accountId)}${record.id}`, hash);
  return { key, record };
}

export async function listApiKeys(kv: KvStore, accountId: string): Promise<ApiKeyInfo[]> {
  const out: ApiKeyInfo[] = [];
  for (const k of await indexEntries(kv, accountId)) {
    const hash = await kv.kvGet<string>(k);
    const rec = hash ? await kv.kvGet<ApiKeyRecord>(recordKey(hash)) : null;
    if (!rec) continue;
    const { accountId: _owner, ...info } = rec;
    out.push(info);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Delete one of an account's keys. Returns false when the account has no key with that id. */
export async function deleteApiKey(kv: KvStore, accountId: string, keyId: string): Promise<boolean> {
  if (!/^key_[A-Za-z0-9_-]{1,32}$/.test(keyId)) return false;
  const idx = `${indexPrefix(accountId)}${keyId}`;
  const hash = await kv.kvGet<string>(idx);
  if (!hash) return false;
  await kv.kvDelete(recordKey(hash));
  await kv.kvDelete(idx);
  return true;
}

/** Resolve a presented key to its record, updating last-used at most hourly. Null for unknown keys. */
export async function resolveApiKey(kv: KvStore, key: string, now = Date.now()): Promise<ApiKeyRecord | null> {
  if (!looksLikeApiKey(key)) return null;
  const hash = await hashApiKey(key);
  const rec = await kv.kvGet<ApiKeyRecord>(recordKey(hash));
  if (!rec) return null;
  if (!rec.lastUsedAt || now - Date.parse(rec.lastUsedAt) >= TOUCH_EVERY_MS) {
    const next = { ...rec, lastUsedAt: new Date(now).toISOString() };
    await kv.kvSet(recordKey(hash), next);
    return next;
  }
  return rec;
}
