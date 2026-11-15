/**
 * Provider keys. Stored in IndexedDB database `v2c-settings`, object store
 * `kv`, key `providerKeys`, as env-style names (GROQ_API_KEY,
 * TRANSFORMERS_STT_MODEL). Shared with the chat app through the same database.
 *
 * They are sent to the provider a key belongs to when this browser does the
 * work. They go to the vid2context server only when the user turned that on
 * (key `shareKeysWithServer`, off by default) and the server accepts keys per
 * request; then only the names it lists, in X-Vid2Context-Keys, used for that
 * request and never stored there.
 */
import { openDb, promisify, txDone } from './idb.ts';

const DB = 'v2c-settings';
const VERSION = 1;
const STORE = 'kv';
const KEY = 'providerKeys';
const SHARE = 'shareKeysWithServer';

export type ProviderKeys = Record<string, string>;

function db(): Promise<IDBDatabase> {
  return openDb(DB, VERSION, (d) => {
    if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
  });
}

export async function loadProviderKeys(): Promise<ProviderKeys> {
  const d = await db();
  const v = await promisify(d.transaction(STORE).objectStore(STORE).get(KEY));
  return v && typeof v === 'object' ? (v as ProviderKeys) : {};
}

/** Env var names: letters, digits and underscores, starting with a letter. */
export const KEY_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Trim names and values, drop empty rows, uppercase names. */
export function cleanKeys(rows: { name: string; value: string }[]): ProviderKeys {
  const out: ProviderKeys = {};
  for (const r of rows) {
    const name = r.name.trim().toUpperCase();
    const value = r.value.trim();
    if (name && value) out[name] = value;
  }
  return out;
}

export async function saveProviderKeys(keys: ProviderKeys): Promise<void> {
  const d = await db();
  const tx = d.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(keys, KEY);
  await txDone(tx);
}

/** Whether saved keys may be sent with requests to the vid2context server. Off until the user turns it on. */
export async function loadShareKeys(): Promise<boolean> {
  const d = await db();
  return (await promisify(d.transaction(STORE).objectStore(STORE).get(SHARE))) === true;
}

export async function saveShareKeys(on: boolean): Promise<void> {
  const d = await db();
  const tx = d.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(on, SHARE);
  await txDone(tx);
}

/** Save `added` on top of the saved keys (empty values are ignored). */
export async function addProviderKeys(added: ProviderKeys): Promise<void> {
  const current = await loadProviderKeys().catch(() => ({}));
  const next = { ...current };
  for (const [name, value] of Object.entries(added)) if (value.trim()) next[name] = value.trim();
  await saveProviderKeys(next);
}

/** The saved keys the server accepts (`accepted`), when sharing is on. Empty otherwise, and on any storage failure. */
export async function keysForServer(accepted: readonly string[] | undefined): Promise<ProviderKeys> {
  if (!accepted || accepted.length === 0) return {};
  try {
    if (!(await loadShareKeys())) return {};
    const keys = await loadProviderKeys();
    const allowed = new Set(accepted);
    return Object.fromEntries(Object.entries(keys).filter(([name]) => allowed.has(name)));
  } catch {
    return {};
  }
}
