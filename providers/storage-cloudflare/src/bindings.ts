/**
 * The parts of the Cloudflare D1, R2, KV and Vectorize binding APIs this
 * backend uses, typed structurally so the repo needs no global Workers types.
 */
import { type Ctx, Vid2ContextError } from '@vid2context/core';

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface R2ObjectBody {
  text(): Promise<string>;
}

export interface R2Bucket {
  put(key: string, value: string | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(
    key: string,
  ): Promise<(R2ObjectBody & { httpMetadata?: { contentType?: string } } & { arrayBuffer(): Promise<ArrayBuffer> }) | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface KVNamespace {
  get(key: string, type: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; expiration?: number }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface VectorizeMatch {
  id: string;
  score: number;
}

export interface VectorizeIndex {
  upsert(vectors: { id: string; values: number[]; metadata?: Record<string, string | number> }[]): Promise<unknown>;
  query(
    vector: number[],
    options: { topK?: number; filter?: Record<string, unknown>; returnValues?: boolean; returnMetadata?: boolean | string },
  ): Promise<{ matches: VectorizeMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

const SNIPPETS: Record<string, (name: string) => string> = {
  d1: (n) => `"d1_databases": [{ "binding": "${n}", "database_name": "vid2context", "database_id": "<id>" }]`,
  r2: (n) => `"r2_buckets": [{ "binding": "${n}", "bucket_name": "vid2context" }]`,
  kv: (n) => `"kv_namespaces": [{ "binding": "${n}", "id": "<id>" }]`,
  vectorize: (n) => `"vectorize": [{ "binding": "${n}", "index_name": "vid2context-bge-m3" }]`,
};

/** Read a binding by name from ctx.bindings and check its shape, or throw with the wrangler.jsonc entry that creates it. */
export function binding<T>(ctx: Ctx, kind: 'd1' | 'r2' | 'kv' | 'vectorize', name: string, method: string, envVar: string): T {
  const b = ctx.bindings?.[name] as Record<string, unknown> | undefined;
  if (!b || typeof b[method] !== 'function') {
    throw new Vid2ContextError(
      'no-provider',
      `${envVar}=${name}, but no ${kind.toUpperCase()} binding named "${name}" is available.`,
      {
        hint: `Add ${SNIPPETS[kind]?.(name)} to wrangler.jsonc, or unset ${envVar}.`,
      },
    );
  }
  return b as T;
}
