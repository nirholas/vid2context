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

/** Opens a Db for the configured driver. Each entry point supplies the drivers its runtime can load. */
export type Connector = (opts: ConnectOptions, ctx: Ctx) => Promise<Db>;
