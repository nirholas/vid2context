/**
 * Reads the Postgres settings from env. Pure and synchronous, so isEnabled can
 * use it too. Nothing here ever logs or returns the connection string in an
 * error message.
 */
import { type Env, type Runtime, Vid2ContextError } from '@vid2context/core';

export interface PgConfig {
  url: string;
  schema: string;
  tenant: string;
  driver: 'postgres' | 'neon-http';
  poolMax: number;
  statementTimeoutMs?: number;
  neonFetchEndpoint?: string;
}

export const DEFAULT_SCHEMA = 'vid2context';
export const DEFAULT_TENANT = 'default';

/** The database URL, VID2CONTEXT_DATABASE_URL first. */
export function databaseUrl(env: Env): string | undefined {
  return env.VID2CONTEXT_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || undefined;
}

/** True when the URL's host is a Neon endpoint (neon.tech or neon.build). */
export function isNeonUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)neon\.(tech|build)$/.test(host);
  } catch {
    return false;
  }
}

export function assertSchemaName(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Vid2ContextError('bad-request', `Invalid Postgres schema name: ${JSON.stringify(schema)}`, {
      hint: 'Set VID2CONTEXT_PG_SCHEMA to lowercase letters, digits and underscores, starting with a letter or underscore (max 63).',
    });
  }
  return schema;
}

export function assertTenant(tenant: string): string {
  if (tenant.length === 0 || tenant.length > 200 || tenant.includes('\u0000')) {
    throw new Vid2ContextError('bad-request', 'Invalid tenant id.', {
      hint: 'Set VID2CONTEXT_TENANT to a non-empty id of at most 200 characters.',
    });
  }
  return tenant;
}

function positiveInt(env: Env, name: string, fallback: number | undefined): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Vid2ContextError('bad-request', `${name} must be a positive integer, got ${JSON.stringify(raw)}.`, {
      hint: `Fix or remove ${name}.`,
    });
  }
  return n;
}

export function readConfig(env: Env, runtime: Runtime): PgConfig {
  const url = databaseUrl(env);
  if (!url) {
    throw new Vid2ContextError('bad-request', 'Postgres storage needs a database URL.', {
      hint: 'Set VID2CONTEXT_DATABASE_URL or DATABASE_URL to a postgres:// connection string, or unset VID2CONTEXT_STORAGE=postgres.',
    });
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Vid2ContextError('bad-request', 'The database URL is not a postgres:// or postgresql:// URL.', {
      hint: 'Check VID2CONTEXT_DATABASE_URL or DATABASE_URL.',
    });
  }
  const forced = env.VID2CONTEXT_PG_DRIVER?.trim();
  if (forced && forced !== 'postgres' && forced !== 'neon-http') {
    throw new Vid2ContextError('bad-request', `Unknown VID2CONTEXT_PG_DRIVER: ${JSON.stringify(forced)}`, {
      hint: "Use 'postgres' (TCP, Node) or 'neon-http' (Neon over HTTPS, Node and Workers), or unset it.",
    });
  }
  const driver = (forced as PgConfig['driver'] | undefined) ?? (runtime === 'node' ? 'postgres' : 'neon-http');
  if (driver === 'neon-http' && !forced && !isNeonUrl(url)) {
    throw new Vid2ContextError('unsupported-input', `Postgres storage on ${runtime} needs a Neon database.`, {
      hint: 'Outside Node only Neon is supported (its HTTP driver needs no sockets). Point DATABASE_URL at a Neon database, or run on Node.',
    });
  }
  return {
    url,
    schema: assertSchemaName(env.VID2CONTEXT_PG_SCHEMA?.trim() || DEFAULT_SCHEMA),
    tenant: assertTenant(env.VID2CONTEXT_TENANT?.trim() || DEFAULT_TENANT),
    driver,
    poolMax: positiveInt(env, 'VID2CONTEXT_PG_POOL_MAX', 10) ?? 10,
    statementTimeoutMs: positiveInt(env, 'VID2CONTEXT_PG_STATEMENT_TIMEOUT_MS', undefined),
    neonFetchEndpoint: env.VID2CONTEXT_PG_NEON_FETCH_ENDPOINT?.trim() || undefined,
  };
}
