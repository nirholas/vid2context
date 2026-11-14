/**
 * Workers entry of @vid2context/provider-storage-postgres, chosen by bundlers
 * through the "workerd" and "worker" export conditions. Workers cannot open
 * TCP sockets without nodejs_compat, so only Neon's HTTP driver is wired in:
 * DATABASE_URL must point at a Neon database. Everything else (schema,
 * tenancy, migrations, search, KV, vectors) is the same code as on Node.
 */
import { Vid2ContextError } from '@vid2context/core';
import type { Connector } from './db.ts';
import { connectNeonHttp } from './db-neon.ts';
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

/** Neon HTTP only. */
export const connectWorkers: Connector = (opts, ctx) => {
  if (opts.driver !== 'neon-http') {
    throw new Vid2ContextError('unsupported-input', 'The postgres.js driver is not available on Workers.', {
      hint: 'Point DATABASE_URL at a Neon database, or set VID2CONTEXT_PG_DRIVER=neon-http.',
    });
  }
  return connectNeonHttp(opts, ctx);
};

export const openPostgresStorage = storageOpener(connectWorkers);

export default postgresProvider(connectWorkers);
