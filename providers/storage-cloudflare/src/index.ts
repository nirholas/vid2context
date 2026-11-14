/**
 * Storage backend on Cloudflare D1 (with R2 and KV), for the Worker.
 *
 * Enabled when the Worker sets VID2CONTEXT_D1 to the name of its D1 binding.
 * Optional: VID2CONTEXT_R2 (bucket for large contexts and uploaded media) and
 * VID2CONTEXT_KV (namespace for KvStore; without it KV rows live in a D1 table).
 * The bindings themselves are read from ctx.bindings when create() runs.
 * VID2CONTEXT_STORAGE=memory (or another backend's name) turns it off.
 */
import { type Ctx, defineProvider, type Env, type Storage, type StorageProvider } from '@vid2context/core';
import { binding, type D1Database, type KVNamespace, type R2Bucket } from './bindings.ts';
import { CloudflareStorage, ensureSchema } from './storage.ts';

export type { D1Database, KVNamespace, R2Bucket } from './bindings.ts';
export { LATEST_VERSION, MIGRATIONS, type Migration, migrationSql } from './migrations.ts';
export {
  CloudflareStorage,
  type CloudflareStorageOptions,
  D1_MAX_CONTEXT_BYTES,
  ensureSchema,
  ftsQuery,
  KV_MIN_TTL_SEC,
  R2_THRESHOLD_BYTES,
} from './storage.ts';

/** Build the storage from the bindings named in env. */
export async function createCloudflareStorage(ctx: Ctx): Promise<CloudflareStorage> {
  const env = ctx.env;
  const dbName = env.VID2CONTEXT_D1 ?? 'DB';
  const db = binding<D1Database>(ctx, 'd1', dbName, 'prepare', 'VID2CONTEXT_D1');
  const r2 = env.VID2CONTEXT_R2 ? binding<R2Bucket>(ctx, 'r2', env.VID2CONTEXT_R2, 'put', 'VID2CONTEXT_R2') : undefined;
  const kv = env.VID2CONTEXT_KV ? binding<KVNamespace>(ctx, 'kv', env.VID2CONTEXT_KV, 'list', 'VID2CONTEXT_KV') : undefined;
  await ensureSchema(db);
  return new CloudflareStorage({ db, r2, kv });
}

/** Names VID2CONTEXT_STORAGE accepts for this backend. */
const NAMES = new Set(['cloudflare', 'storage-cloudflare', 'd1']);

/** True when VID2CONTEXT_D1 names a binding, unless VID2CONTEXT_STORAGE picks another backend. */
export function cloudflareStorageEnabled(env: Env): boolean {
  const chosen = env.VID2CONTEXT_STORAGE?.trim().toLowerCase();
  if (chosen && !NAMES.has(chosen)) return false;
  return Boolean(env.VID2CONTEXT_D1);
}

const provider: StorageProvider = defineProvider({
  id: 'storage-cloudflare',
  kind: 'storage',
  name: 'Cloudflare D1, R2 and KV',
  runtimes: ['workers'],
  // Ahead of MemoryStorage, the fallback when no persistent backend is enabled.
  priority: 20,
  isEnabled: cloudflareStorageEnabled,
  create: (ctx: Ctx): Promise<Storage> => createCloudflareStorage(ctx),
});

export default provider;
