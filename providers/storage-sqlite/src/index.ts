/**
 * @vid2context/provider-storage-sqlite: the persistent local library on
 * node:sqlite. Enabled by default on Node; one file under .vid2context/.
 */
import { defineProvider, type Env, type StorageProvider } from '@vid2context/core';
import { DEFAULT_BUSY_TIMEOUT_MS, databasePath, sqliteAvailable } from './db.ts';
import { SqliteStorage } from './storage.ts';

export { DEFAULT_BUSY_TIMEOUT_MS, databasePath, type OpenOptions, SCHEMA_VERSION } from './db.ts';
export { parseSearch, type SearchTerm, toMatchExpression } from './query.ts';
export { SqliteStorage } from './storage.ts';

/**
 * Lower priority wins in registry.openStorage. Remote backends that need
 * explicit configuration (Postgres) take a lower number so they win when set;
 * SQLite needs no configuration and wins over having no storage at all.
 */
export const SQLITE_PRIORITY = 50;

/** Names VID2CONTEXT_STORAGE accepts for this backend. */
const NAMES = new Set(['sqlite', 'storage-sqlite']);

/** True unless VID2CONTEXT_STORAGE names another backend. */
export function sqliteEnabled(env: Env): boolean {
  const chosen = env.VID2CONTEXT_STORAGE?.trim().toLowerCase();
  if (chosen && !NAMES.has(chosen)) return false;
  return sqliteAvailable();
}

function busyTimeout(env: Env): number {
  const raw = env.VID2CONTEXT_DB_BUSY_TIMEOUT_MS?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BUSY_TIMEOUT_MS;
}

let warnedLike = false;

export const storageSqlite = defineProvider<StorageProvider>({
  id: 'storage-sqlite',
  kind: 'storage',
  name: 'SQLite library (local file)',
  runtimes: ['node'],
  priority: SQLITE_PRIORITY,
  isEnabled: sqliteEnabled,
  async create(ctx) {
    const storage = new SqliteStorage({ path: databasePath(ctx.env), busyTimeoutMs: busyTimeout(ctx.env) });
    if (storage.searchMode === 'like' && !warnedLike) {
      warnedLike = true;
      ctx.log.warn('SQLite in this Node.js build has no FTS5; library search falls back to substring matching.', {
        path: storage.path,
      });
    }
    ctx.log.debug('storage-sqlite opened', { path: storage.path, search: storage.searchMode, schema: storage.schemaVersion });
    return storage;
  },
});

export default storageSqlite;
