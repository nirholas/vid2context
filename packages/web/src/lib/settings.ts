/**
 * Provider keys for client-only mode. Stored in IndexedDB database
 * `v2c-settings`, object store `kv`, key `providerKeys`, as env-style names
 * (GROQ_API_KEY, TRANSFORMERS_STT_MODEL). Shared with the chat app through the
 * same database. They are only ever sent to the provider a key belongs to.
 */
import { openDb, promisify, txDone } from './idb.ts';

const DB = 'v2c-settings';
const VERSION = 1;
const STORE = 'kv';
const KEY = 'providerKeys';

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
