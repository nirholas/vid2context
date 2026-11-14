/**
 * Db adapter over PGlite (Postgres 18 compiled to WebAssembly, with the real
 * pgvector extension). A real database engine in-process, so unit tests run
 * the exact SQL production runs, offline.
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Db, Param, Row, Statement } from '../src/db.ts';

export async function newPGlite(): Promise<PGlite> {
  return PGlite.create({ extensions: { vector } });
}

export function pgliteDb(pg: PGlite): Db {
  return {
    driver: 'pglite',
    async query<T extends Row = Row>(text: string, params: Param[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
    async batch(statements: Statement[]): Promise<Row[][]> {
      return pg.transaction(async (tx) => {
        const out: Row[][] = [];
        for (const s of statements) out.push((await tx.query<Row>(s.text, s.params ?? [])).rows);
        return out;
      });
    },
    async close(): Promise<void> {
      // The test owns the PGlite instance and closes it.
    },
  };
}
