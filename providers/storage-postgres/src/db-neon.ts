/** Neon serverless HTTP driver. Runtime-neutral (fetch only), used by both entries. */
import { neon, neonConfig } from '@neondatabase/serverless';
import type { Ctx } from '@vid2context/core';
import type { ConnectOptions, Db, Param, Row, Statement } from './db.ts';

/**
 * Connects with Neon's serverless HTTP driver: one HTTPS request per query or
 * transaction, no sockets, so it runs on Cloudflare Workers. Requests go
 * through ctx.fetch.
 */
export async function connectNeonHttp(opts: ConnectOptions, ctx: Ctx): Promise<Db> {
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
