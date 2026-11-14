/**
 * The small query interface the storage is written against. Every statement
 * is plain SQL with $1..$n parameters, and parameters are only strings,
 * numbers, booleans or null (JSON travels as text and is cast in SQL as
 * `$n::text::jsonb`: postgres.js JSON-encodes any parameter the server types
 * as jsonb, which would encode the text a second time), so the
 * same SQL runs unchanged on postgres.js (Node), Neon's HTTP driver
 * (Workers) and PGlite (tests).
 *
 * `batch` runs statements in order inside one transaction and returns each
 * statement's rows. It is non-interactive on purpose: Neon's HTTP driver can
 * only run transactions that way, so the storage never needs to read a row
 * mid-transaction to decide what to do next.
 */
import type { Ctx } from '@vid2context/core';

export type Param = string | number | boolean | null;
export type Row = Record<string, unknown>;

export interface Statement {
  text: string;
  params?: Param[];
}

export interface Db {
  /** Driver name for health and error output: 'postgres', 'neon-http', 'pglite'. */
  readonly driver: string;
  query<T extends Row = Row>(text: string, params?: Param[]): Promise<T[]>;
  batch(statements: Statement[]): Promise<Row[][]>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  url: string;
  driver: 'postgres' | 'neon-http';
  poolMax: number;
  /** Sent as a startup parameter only when set: PgBouncer-style poolers reject unknown startup parameters. */
  statementTimeoutMs?: number;
  /** Neon HTTP endpoint override, for a local Neon proxy or a self-hosted Neon. */
  neonFetchEndpoint?: string;
}

/** Connects with postgres.js (porsager). Node only. */
async function connectPostgres(opts: ConnectOptions, ctx: Ctx): Promise<Db> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(opts.url, {
    max: opts.poolMax,
    // Transaction-mode poolers (Supabase on port 6543, PgBouncer) reject named
    // prepared statements, and unnamed ones are planned with the real
    // parameter values, which partial indexes need.
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 15,
    connection: {
      application_name: 'vid2context',
      ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
    },
    // postgres.js prints notices to stdout by default; stdout is reserved.
    onnotice: (notice) => ctx.log.debug('postgres notice', { message: String(notice.message ?? '') }),
  });
  return {
    driver: 'postgres',
    async query<T extends Row = Row>(text: string, params: Param[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params);
      return [...rows] as unknown as T[];
    },
    async batch(statements: Statement[]): Promise<Row[][]> {
      const out: Row[][] = [];
      await sql.begin(async (tx) => {
        for (const s of statements) {
          const rows = await tx.unsafe(s.text, s.params ?? []);
          out.push([...rows] as unknown as Row[]);
        }
      });
      return out;
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * Connects with Neon's serverless HTTP driver: one HTTPS request per query or
 * transaction, no sockets, so it runs on Cloudflare Workers. Requests go
 * through ctx.fetch.
 */
async function connectNeonHttp(opts: ConnectOptions, ctx: Ctx): Promise<Db> {
  const { neon, neonConfig } = await import('@neondatabase/serverless');
  // Both settings are global in the driver; every caller sets the same values.
  neonConfig.fetchFunction = ctx.fetch;
  if (opts.neonFetchEndpoint) {
    const endpoint = opts.neonFetchEndpoint;
    neonConfig.fetchEndpoint = () => endpoint;
  }
  const sql = neon(opts.url, { fullResults: false, arrayMode: false });
  return {
    driver: 'neon-http',
    async query<T extends Row = Row>(text: string, params: Param[] = []): Promise<T[]> {
      return (await sql.query(text, params)) as T[];
    },
    async batch(statements: Statement[]): Promise<Row[][]> {
      const results = await sql.transaction(statements.map((s) => sql.query(s.text, s.params ?? [])));
      return results as Row[][];
    },
    async close(): Promise<void> {
      // Stateless: nothing to close.
    },
  };
}

export async function connect(opts: ConnectOptions, ctx: Ctx): Promise<Db> {
  return opts.driver === 'neon-http' ? connectNeonHttp(opts, ctx) : connectPostgres(opts, ctx);
}
