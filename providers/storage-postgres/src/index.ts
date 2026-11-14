/**
 * @vid2context/provider-storage-postgres: the library (saved contexts,
 * collections, full-text search) plus the KV and vector extensions on
 * Postgres with pgvector.
 *
 * Enabled when VID2CONTEXT_DATABASE_URL or DATABASE_URL is set, and wins over
 * SQLite (lower priority number). VID2CONTEXT_STORAGE=postgres forces it;
 * any other VID2CONTEXT_STORAGE value disables it.
 *
 * Connections are pooled per process: every create(ctx) with the same
 * settings shares one pool and migrates the schema once.
 *
 * This is the Node entry: postgres.js over TCP by default, Neon's HTTP driver
 * when VID2CONTEXT_PG_DRIVER=neon-http. Bundlers targeting Workers resolve
 * the package to ./workers.ts instead (see "exports" in package.json).
 */
import type { Connector } from './db.ts';
import { connectNeonHttp } from './db-neon.ts';
import { connectPostgres } from './db-postgres.ts';
import { postgresProvider, storageOpener } from './provider.ts';

export {
  assertSchemaName,
  assertTenant,
  DEFAULT_SCHEMA,
  DEFAULT_TENANT,
  databaseUrl,
  isNeonUrl,
  type PgConfig,
  readConfig,
} from './config.ts';
export type { ConnectOptions, Connector, Db, Param, Row, Statement } from './db.ts';
export { connectNeonHttp } from './db-neon.ts';
export { connectPostgres } from './db-postgres.ts';
export { scrub, secretsOf, toStorageError } from './errors.ts';
export { type MigrateResult, migrate } from './migrate.ts';
export { type Migration, migrations } from './migrations.generated.ts';
export {
  createPostgresStorage,
  isPostgresEnabled,
  POSTGRES_PRIORITY,
  type PrepareOptions,
  postgresProvider,
  storageOpener,
} from './provider.ts';
export { indexTypeFor, type PgSearchHit, PostgresStorage, TS_CONFIGS, tsConfigFor } from './storage.ts';

/** Node drivers: postgres.js, or Neon HTTP when asked for. */
export const connectNode: Connector = (opts, ctx) =>
  opts.driver === 'neon-http' ? connectNeonHttp(opts, ctx) : connectPostgres(opts, ctx);

/** Opens (or reuses) the pool for ctx.env and returns a storage bound to VID2CONTEXT_TENANT. */
export const openPostgresStorage = storageOpener(connectNode);

export default postgresProvider(connectNode);
