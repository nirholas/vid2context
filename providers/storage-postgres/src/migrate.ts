/**
 * Versioned, additive migrations from migrations/*.sql.
 *
 * All pending work runs in one transaction that first takes
 * pg_advisory_xact_lock on a key derived from the schema name, so two
 * instances starting at once queue up instead of racing. Each migration is
 * wrapped in a DO block that checks schema_migrations after the lock is held
 * and only then EXECUTEs the file, so a migration runs exactly once even when
 * a second instance was waiting on the lock. The transaction-scoped lock (not
 * the session-scoped pg_advisory_lock) is what makes this work through
 * transaction-mode poolers and Neon's HTTP driver, where a session does not
 * outlive one transaction.
 */
import type { Db } from './db.ts';
import { type Migration, migrations as bundled } from './migrations.generated.ts';

const OUTER_TAG = '$vid2context_outer$';
const INNER_TAG = '$vid2context_migration$';

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function migrationBlock(m: Migration, schema: string): string {
  const S = quoteIdent(schema);
  const sql = m.sql.split('{{schema}}').join(S);
  if (sql.includes(OUTER_TAG) || sql.includes(INNER_TAG)) {
    throw new Error(`Migration ${m.version} uses a reserved dollar-quote tag.`);
  }
  if (!/^[a-z0-9_]+$/.test(m.name) || !Number.isInteger(m.version)) {
    throw new Error(`Migration ${m.version} has an invalid name or version.`);
  }
  return [
    `DO ${OUTER_TAG}`,
    'BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM ${S}.schema_migrations WHERE version = ${m.version}) THEN`,
    `    EXECUTE ${INNER_TAG}${sql}${INNER_TAG};`,
    `    INSERT INTO ${S}.schema_migrations (version, name) VALUES (${m.version}, ${quoteLiteral(m.name)});`,
    '  END IF;',
    'END',
    OUTER_TAG,
  ].join('\n');
}

export interface MigrateResult {
  /** Versions applied by this call (empty when the schema was already current). */
  applied: number[];
  /** Highest version present after the call. */
  version: number;
}

/** Brings `schema` up to the latest migration. Safe to call from many instances at once. */
export async function migrate(db: Db, schema: string, list: Migration[] = bundled): Promise<MigrateResult> {
  const S = quoteIdent(schema);
  const latest = list.reduce((max, m) => Math.max(max, m.version), 0);

  // Fast path without the lock or any DDL, so a role without CREATE rights
  // can still use a schema that someone else migrated.
  try {
    const rows = await db.query<{ v: number }>(`SELECT coalesce(max(version), 0)::int AS v FROM ${S}.schema_migrations`);
    const current = Number(rows[0]?.v ?? 0);
    if (current >= latest) return { applied: [], version: current };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    // 42P01 undefined_table, 3F000 invalid_schema_name: first run.
    if (code !== '42P01' && code !== '3F000') throw err;
  }

  const ordered = [...list].sort((a, b) => a.version - b.version);
  const results = await db.batch([
    { text: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: [`vid2context:migrate:${schema}`] },
    {
      text: `DO ${OUTER_TAG} BEGIN IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${quoteLiteral(schema)}) THEN EXECUTE 'CREATE SCHEMA ${S.replace(/'/g, "''")}'; END IF; END ${OUTER_TAG}`,
    },
    {
      text: `CREATE TABLE IF NOT EXISTS ${S}.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    },
    ...ordered.map((m) => ({ text: migrationBlock(m, schema) })),
    // now() is the transaction start, so rows inserted above carry exactly it.
    { text: `SELECT version FROM ${S}.schema_migrations WHERE applied_at = now() ORDER BY version` },
    { text: `SELECT coalesce(max(version), 0)::int AS v FROM ${S}.schema_migrations` },
  ]);
  const applied = (results.at(-2) ?? []).map((r) => Number(r.version));
  const version = Number(results.at(-1)?.[0]?.v ?? 0);
  return { applied, version };
}
