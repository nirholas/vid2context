/**
 * Browser sessions. The cookie carries an opaque random id signed with
 * VID2CONTEXT_SESSION_SECRET (HMAC-SHA256 through WebCrypto). The record
 * lives in the KvStore under the SHA-256 of the id, so a copy of the store
 * alone cannot be replayed as cookies. Logout deletes the record.
 *
 * Keys:
 *   accounts:session:<sha256(id)>   SessionRecord (expires with the session)
 */
import type { KvStore } from '@vid2context/core';
import { randomToken, sha256Hex, sign, unsign } from './crypto.ts';

export const SESSION_COOKIE = '__Host-v2c_session';

export interface SessionRecord {
  accountId: string;
  /** ISO 8601. */
  createdAt: string;
  expiresAt: string;
}

const sessionKey = async (id: string) => `accounts:session:${await sha256Hex(id)}`;

/** Create a session and return the signed cookie value. */
export async function createSession(
  kv: KvStore,
  secret: string,
  accountId: string,
  opts: { ttlSec: number; now?: number },
): Promise<{ cookie: string; record: SessionRecord }> {
  const now = opts.now ?? Date.now();
  const id = randomToken(32);
  const record: SessionRecord = {
    accountId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + opts.ttlSec * 1000).toISOString(),
  };
  await kv.kvSet(await sessionKey(id), record, { ttlSec: opts.ttlSec });
  return { cookie: await sign(secret, id), record };
}

/** The live session behind a signed cookie value, or null when it is missing, tampered with or expired. */
export async function readSession(
  kv: KvStore,
  secret: string,
  cookie: string | undefined,
  now = Date.now(),
): Promise<SessionRecord | null> {
  if (!cookie || cookie.length > 256) return null;
  const id = await unsign(secret, cookie);
  if (!id) return null;
  const key = await sessionKey(id);
  const record = await kv.kvGet<SessionRecord>(key);
  if (!record) return null;
  if (Date.parse(record.expiresAt) <= now) {
    await kv.kvDelete(key);
    return null;
  }
  return record;
}

/** Delete the session behind a signed cookie value. Unsigned or unknown values are ignored. */
export async function deleteSession(kv: KvStore, secret: string, cookie: string | undefined): Promise<void> {
  if (!cookie) return;
  const id = await unsign(secret, cookie);
  if (id) await kv.kvDelete(await sessionKey(id));
}
