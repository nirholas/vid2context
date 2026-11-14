/**
 * Runtime-neutral core of the provider: settings, migrations, the shared
 * per-process pool and the provider definition. The entry points (index.ts
 * for Node, workers.ts for Workers) pass in the drivers their runtime can
 * load, so a Workers bundle never contains postgres.js.
 */
import { type Ctx, defineProvider, type Env, type StorageProvider } from '@vid2context/core';
import {
  assertSchemaName,
  assertTenant,
  DEFAULT_SCHEMA,
  DEFAULT_TENANT,
  databaseUrl,
  type PgConfig,
  readConfig,
} from './config.ts';
import type { Connector, Db } from './db.ts';
import { secretsOf, toStorageError } from './errors.ts';
import { type MigrateResult, migrate } from './migrate.ts';
import { PostgresStorage, type Shared } from './storage.ts';

/** Lower wins. SQLite (prompt 37) sits above this so a configured Postgres takes over. */
export const POSTGRES_PRIORITY = 10;

export function isPostgresEnabled(env: Env): boolean {
  const forced = env.VID2CONTEXT_STORAGE?.trim().toLowerCase();
  if (forced) return forced === 'postgres';
  return databaseUrl(env) !== undefined;
}

export interface PrepareOptions {
  db: Db;
  schema?: string;
  tenant?: string;
  /** Strings scrubbed from error messages (the connection string, the password). */
  secrets?: string[];
  /** Called by storage.close(). Default: closes the Db. */
  release?: () => Promise<void>;
}

async function prepareShared(opts: PrepareOptions): Promise<{ shared: Shared; migrations: MigrateResult }> {
  const schema = assertSchemaName(opts.schema ?? DEFAULT_SCHEMA);
  const secrets = opts.secrets ?? [];
  let migrations: MigrateResult;
  try {
    migrations = await migrate(opts.db, schema);
  } catch (err) {
    throw toStorageError(err, secrets);
  }
  const shared: Shared = {
    db: opts.db,
    schema,
    secrets,
    vectorModels: new Map(),
    release: opts.release ?? (() => opts.db.close()),
  };
  return { shared, migrations };
}

/**
 * Builds a storage on an already open Db: runs migrations, then binds the
 * tenant. For callers that manage their own connection (tests on PGlite, a
 * server sharing one pool across tenants).
 */
export async function createPostgresStorage(
  opts: PrepareOptions,
): Promise<{ storage: PostgresStorage; migrations: MigrateResult }> {
  const { shared, migrations } = await prepareShared(opts);
  return { storage: new PostgresStorage(shared, assertTenant(opts.tenant ?? DEFAULT_TENANT)), migrations };
}

interface Pooled {
  shared: Promise<Shared>;
  refs: number;
}

const pools = new Map<string, Pooled>();

function poolKey(c: PgConfig): string {
  return JSON.stringify([c.driver, c.url, c.schema, c.poolMax, c.statementTimeoutMs ?? null, c.neonFetchEndpoint ?? null]);
}

async function openShared(connect: Connector, config: PgConfig, ctx: Ctx, key: string): Promise<Shared> {
  const secrets = secretsOf(config.url);
  let db: Db;
  try {
    db = await connect(
      {
        url: config.url,
        driver: config.driver,
        poolMax: config.poolMax,
        statementTimeoutMs: config.statementTimeoutMs,
        neonFetchEndpoint: config.neonFetchEndpoint,
      },
      ctx,
    );
  } catch (err) {
    throw toStorageError(err, secrets);
  }
  const release = async (): Promise<void> => {
    const entry = pools.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      pools.delete(key);
      await db.close();
    }
  };
  try {
    const { shared, migrations } = await prepareShared({ db, schema: config.schema, secrets, release });
    if (migrations.applied.length > 0) {
      ctx.log.info('postgres storage migrated', {
        schema: config.schema,
        applied: migrations.applied,
        version: migrations.version,
      });
    }
    return shared;
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Returns create(ctx) for an entry point: opens (or reuses) the pool for
 * ctx.env with the given connector and returns a storage bound to
 * VID2CONTEXT_TENANT.
 */
export function storageOpener(connect: Connector): (ctx: Ctx) => Promise<PostgresStorage> {
  return (ctx) => openWith(connect, ctx);
}

async function openWith(connect: Connector, ctx: Ctx): Promise<PostgresStorage> {
  const config = readConfig(ctx.env, ctx.runtime);
  const key = poolKey(config);
  let entry = pools.get(key);
  if (!entry) {
    entry = { shared: openShared(connect, config, ctx, key), refs: 0 };
    pools.set(key, entry);
    entry.shared.catch(() => {
      // A failed connect or migration is not cached: the next call retries.
      if (pools.get(key) === entry) pools.delete(key);
    });
  }
  entry.refs += 1;
  try {
    const shared = await entry.shared;
    ctx.log.debug('postgres storage ready', { driver: shared.db.driver, schema: config.schema, tenant: config.tenant });
    return new PostgresStorage(shared, config.tenant);
  } catch (err) {
    entry.refs -= 1;
    throw err;
  }
}

/** The provider definition both entry points export, differing only in their connector. */
export function postgresProvider(connect: Connector): StorageProvider {
  return defineProvider<StorageProvider>({
    id: 'storage-postgres',
    kind: 'storage',
    name: 'Postgres + pgvector',
    runtimes: ['node', 'workers'],
    priority: POSTGRES_PRIORITY,
    isEnabled: isPostgresEnabled,
    create: storageOpener(connect),
  });
}
