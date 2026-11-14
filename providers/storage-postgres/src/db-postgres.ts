/** postgres.js (porsager) driver: TCP with a connection pool. Node only, so only the Node entry imports this file. */
import type { Ctx } from '@vid2context/core';
import postgres from 'postgres';
import type { ConnectOptions, Db, Param, Row, Statement } from './db.ts';

/** Connects with postgres.js (porsager). Node only. */
export async function connectPostgres(opts: ConnectOptions, ctx: Ctx): Promise<Db> {
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
